// Package migrations carries the schema as embedded SQL.
//
// It exists as its own package for one reason: `go:embed` cannot reach a
// parent directory, so whatever embeds the .sql files has to sit beside them.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS

// Dir is the path to pass goose alongside FS. Embedded paths are relative to
// the embedding package, so the migrations are at the root of this FS.
const Dir = "."
