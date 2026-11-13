package proto

// MaxFileTextBytes bounds both the current file and its replacement in a text edit.
const MaxFileTextBytes = 1 << 20

// FileTextEditRequest replaces an existing complete UTF-8 file at its observed revision.
// Text is a pointer so an omitted replacement is not confused with an intentionally empty file.
type FileTextEditRequest struct {
	Path     string  `json:"path"`
	Cwd      string  `json:"cwd,omitempty"`
	Text     *string `json:"text"`
	Revision string  `json:"revision"`
}

type FileTextEditResult struct {
	Revision string `json:"revision"`
}
