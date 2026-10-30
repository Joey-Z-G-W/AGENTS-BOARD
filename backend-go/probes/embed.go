package probes

import _ "embed"

//go:embed legacy.py
var Legacy string

//go:embed continuous.py
var Continuous string
