package main

import (
	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/auth"
	"agents-board/backend-go/internal/collector"
	"agents-board/backend-go/internal/routers"
	"agents-board/backend-go/internal/scheduler"
	"agents-board/backend-go/internal/store"
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"github.com/gin-gonic/gin"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("board", flag.ContinueOnError)
	port := flags.Int("port", 3003, "loopback HTTP port")
	mode := flags.String("mode", "demo", "demo, snapshot or continuous")
	web := flags.String("web-dir", "", "built frontend directory")
	python := flags.String("python", "python", "local Python executable")
	hosts := flags.String("hosts", "", "comma-separated existing SSH targets")
	local := flags.Bool("local", true, "collect this machine in real modes")
	diagnostics := flags.Bool("diagnostics", false, "log collection counts without session contents")
	control := flags.Bool("control-stdin", false, "stop when stdin receives stop or closes")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *port < 1 || *port > 65535 {
		return errors.New("端口或参数无效")
	}
	if *diagnostics {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}
	modes := map[string]api.HealthMode{"demo": api.InMemoryDemo, "snapshot": api.RealSnapshot, "continuous": api.Continuous}
	dataMode, ok := modes[*mode]
	if !ok {
		return errors.New("mode 必须是 demo、snapshot 或 continuous")
	}
	username, password := os.Getenv("BOARD_USERNAME"), os.Getenv("BOARD_PASSWORD")
	if username == "" {
		username = "admin"
	}
	if password == "" {
		password = "admin"
	}
	credentials, err := auth.NewService(ctx, username, password, nil)
	if err != nil {
		return errors.New("启动认证配置无效")
	}
	if password == "admin" {
		slog.Warn("使用本机预览默认密码；可通过 BOARD_PASSWORD 修改")
	}
	memory := store.New(dataMode, nil)
	if dataMode == api.InMemoryDemo {
		memory = store.Demo(time.Now)
	} else if *local {
		memory.AddLocal()
	}
	if *hosts != "" {
		for _, target := range strings.Split(*hosts, ",") {
			if _, err = memory.AddHost(target); err != nil {
				return err
			}
		}
	}
	if dataMode != api.InMemoryDemo {
		if home, err := os.UserHomeDir(); err == nil {
			candidates, err := collector.SSHCandidates(filepath.Join(home, ".ssh", "config"))
			memory.SetCandidates(candidates)
			if err != nil {
				slog.Warn("SSH 候选配置部分未解析；可手动输入目标")
			}
		}
	}
	app := &routers.Application{Store: memory, Auth: credentials}
	origin := "http://127.0.0.1:" + strconv.Itoa(*port)
	gin.SetMode(gin.ReleaseMode)
	router, err := routers.NewApplication(app, []string{origin, "http://localhost:" + strconv.Itoa(*port), "http://127.0.0.1:5173", "http://localhost:5173"})
	if err != nil {
		return err
	}
	if *web != "" {
		root, err := os.OpenRoot(*web)
		if err != nil {
			return errors.New("前端构建目录不可用")
		}
		defer root.Close()
		if err = routers.MountWeb(router, root.FS()); err != nil {
			return errors.New("缺少前端 index.html，请先构建")
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(*port))
	if err != nil {
		return errors.New("本机端口不可用；未停止任何已有程序")
	}
	defer listener.Close()
	lifetime, stop := context.WithCancel(ctx)
	defer stop()
	source := collector.New(*python)
	source.ResolveHost = func(address string) string {
		for _, host := range memory.Hosts().Hosts {
			if strings.EqualFold(host.Address, address) {
				return host.Id
			}
		}
		return ""
	}
	if dataMode == api.Continuous {
		worker := scheduler.New(lifetime, memory, source, 15*time.Second)
		app.Refresher = worker
		defer worker.Close()
	}
	snapshotDone := make(chan struct{})
	if dataMode == api.RealSnapshot {
		go func() {
			defer close(snapshotDone)
			for _, host := range memory.Hosts().Hosts {
				if lifetime.Err() != nil {
					return
				}
				_, generation, _ := memory.Target(host.Id)
				result, err := source.Collect(lifetime, host, nil)
				if err == nil {
					err = memory.Commit(host.Id, generation, result.Projects, result.Sessions, result.At)
				}
				if err != nil {
					memory.Failed(host.Id, generation)
				} else {
					source.Accept(host.Id, result)
					memory.Report(host.Id, generation, result.Failures)
				}
			}
		}()
	} else {
		close(snapshotDone)
	}
	if *control {
		go func() {
			scanner := bufio.NewScanner(os.Stdin)
			scanner.Buffer(make([]byte, 64), 1024)
			for scanner.Scan() {
				if scanner.Text() == "stop" {
					stop()
					return
				}
			}
			stop()
		}()
	}
	server := &http.Server{Handler: router, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	fmt.Printf("Agents Board ready %s mode=%s\n", origin, dataMode)
	select {
	case err = <-served:
		stop()
	case <-lifetime.Done():
	}
	deadline, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if shutdownErr := server.Shutdown(deadline); shutdownErr != nil {
		_ = server.Close()
	}
	stop()
	<-snapshotDone
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return errors.New("HTTP 服务停止异常")
	}
	return nil
}
