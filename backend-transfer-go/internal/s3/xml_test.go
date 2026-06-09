package s3

import (
	"encoding/xml"
	"testing"
)

func TestDeleteInputUnmarshal(t *testing.T) {
	xmlStr := `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
    <Quiet>true</Quiet>
    <Object>
        <Key>folder/file1.txt</Key>
    </Object>
    <Object>
        <Key>file2 &amp; file3.pdf</Key>
    </Object>
</Delete>`

	var input DeleteInput
	err := xml.Unmarshal([]byte(xmlStr), &input)
	if err != nil {
		t.Fatalf("Failed to unmarshal DeleteInput: %v", err)
	}

	if !input.Quiet {
		t.Errorf("Expected Quiet to be true, got %v", input.Quiet)
	}

	if len(input.Objects) != 2 {
		t.Fatalf("Expected 2 objects, got %d", len(input.Objects))
	}

	if input.Objects[0].Key != "folder/file1.txt" {
		t.Errorf("Expected key 'folder/file1.txt', got %q", input.Objects[0].Key)
	}

	if input.Objects[1].Key != "file2 & file3.pdf" {
		t.Errorf("Expected key 'file2 & file3.pdf', got %q", input.Objects[1].Key)
	}
}

func TestCompleteMultipartUploadInputUnmarshal(t *testing.T) {
	xmlStr := `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Part>
        <PartNumber>1</PartNumber>
        <ETag>"a54357788a31438b111e3b8b111e3b8b"</ETag>
    </Part>
    <Part>
        <PartNumber>2</PartNumber>
        <ETag>"0c78a57788a31438b111e3b8b111e3b8"</ETag>
    </Part>
</CompleteMultipartUpload>`

	var input CompleteMultipartUploadInput
	err := xml.Unmarshal([]byte(xmlStr), &input)
	if err != nil {
		t.Fatalf("Failed to unmarshal CompleteMultipartUploadInput: %v", err)
	}

	if len(input.Parts) != 2 {
		t.Fatalf("Expected 2 parts, got %d", len(input.Parts))
	}

	if input.Parts[0].PartNumber != 1 {
		t.Errorf("Expected PartNumber 1, got %d", input.Parts[0].PartNumber)
	}
	if input.Parts[0].ETag != `"a54357788a31438b111e3b8b111e3b8b"` {
		t.Errorf("Expected ETag '\"a54357788a31438b111e3b8b111e3b8b\"', got %q", input.Parts[0].ETag)
	}

	if input.Parts[1].PartNumber != 2 {
		t.Errorf("Expected PartNumber 2, got %d", input.Parts[1].PartNumber)
	}
	if input.Parts[1].ETag != `"0c78a57788a31438b111e3b8b111e3b8"` {
		t.Errorf("Expected ETag '\"0c78a57788a31438b111e3b8b111e3b8\"', got %q", input.Parts[1].ETag)
	}
}

func TestS3KeyEncoding(t *testing.T) {
	key := "docs/photo & image/hello*world.jpg"
	encoded := encodeS3Key(key, "url")
	expected := "docs%2Fphoto%20%26%20image%2Fhello%2Aworld.jpg"

	if encoded != expected {
		t.Errorf("encodeS3Key URL encoded was %q, expected %q", encoded, expected)
	}

	raw := encodeS3Key(key, "")
	if raw != key {
		t.Errorf("encodeS3Key raw was %q, expected %q", raw, key)
	}
}

func TestSplitKey(t *testing.T) {
	tests := []struct {
		input    string
		expected []string
	}{
		{"", nil},
		{"/", nil},
		{"/a/b/c/", []string{"a", "b", "c"}},
		{"a/b/c", []string{"a", "b", "c"}},
		{"///a///b/c///", []string{"a", "b", "c"}},
	}

	for _, test := range tests {
		got := splitKey(test.input)
		if len(got) != len(test.expected) {
			t.Errorf("splitKey(%q) returned %v, expected %v", test.input, got, test.expected)
			continue
		}
		for i := range got {
			if got[i] != test.expected[i] {
				t.Errorf("splitKey(%q) returned %v, expected %v", test.input, got, test.expected)
				break
			}
		}
	}
}
