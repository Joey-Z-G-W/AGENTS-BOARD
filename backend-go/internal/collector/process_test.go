package collector

import (
	"os"
	"strconv"
)

func fmtPID() string { return strconv.Itoa(os.Getpid()) }
