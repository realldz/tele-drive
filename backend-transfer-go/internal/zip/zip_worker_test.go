package zip

import "testing"

func TestUniquePath(t *testing.T) {
	seen := make(map[string]bool)

	if got := uniquePath("a/b/file.txt", seen); got != "a/b/file.txt" {
		t.Fatalf("first occurrence: got %q, want %q", got, "a/b/file.txt")
	}

	if got := uniquePath("a/b/file.txt", seen); got != "a/b/file_1.txt" {
		t.Fatalf("second occurrence: got %q, want %q", got, "a/b/file_1.txt")
	}

	if got := uniquePath("a/b/file.txt", seen); got != "a/b/file_2.txt" {
		t.Fatalf("third occurrence: got %q, want %q", got, "a/b/file_2.txt")
	}

	// Root-level (no directory) file
	if got := uniquePath("root.txt", seen); got != "root.txt" {
		t.Fatalf("root first: got %q, want %q", got, "root.txt")
	}
	if got := uniquePath("root.txt", seen); got != "root_1.txt" {
		t.Fatalf("root second: got %q, want %q", got, "root_1.txt")
	}

	// File without extension
	if got := uniquePath("noext", seen); got != "noext" {
		t.Fatalf("noext first: got %q, want %q", got, "noext")
	}
	if got := uniquePath("noext", seen); got != "noext_1" {
		t.Fatalf("noext second: got %q, want %q", got, "noext_1")
	}
}
