package routers

import (
	"github.com/gin-gonic/gin"
	"io/fs"
	"net/http"
	"strings"
)

// MountWeb serves a prebuilt bundle from a traversal-resistant os.Root FS.
// API errors and missing assets never fall back to index.html.
func MountWeb(router *gin.Engine, files fs.FS) error {
	if _, err := fs.Stat(files, "index.html"); err != nil {
		return err
	}
	handler := http.FileServerFS(files)
	router.NoRoute(func(c *gin.Context) {
		path := strings.TrimPrefix(c.Request.URL.Path, "/")
		if strings.HasPrefix(path, "api/") || path == "api" {
			c.JSON(404, gin.H{"code": "NOT_FOUND", "message": "接口不存在。"})
			return
		}
		if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
			c.Status(405)
			return
		}
		if path == "" {
			path = "index.html"
		}
		info, err := fs.Stat(files, path)
		if err != nil || info.IsDir() || !fs.ValidPath(path) {
			c.Status(404)
			return
		}
		handler.ServeHTTP(c.Writer, c.Request)
	})
	return nil
}
