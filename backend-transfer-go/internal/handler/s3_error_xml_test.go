package handler

import (
	"encoding/xml"
	"github.com/labstack/echo/v4"
	"net/http/httptest"
	"testing"
)

func TestS3ErrorXMLEscapesFields(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest("GET", "/bucket/a%26b%3Ckey", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Response().Header().Set("X-Request-ID", "id&<value>")
	if err := s3ErrorXML(c, 404, "NoSuchKey", "missing <key> & file"); err != nil {
		t.Fatal(err)
	}
	var body struct{ Code, Message, Resource, RequestId string }
	if err := xml.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Resource != "/bucket/a&b<key" || body.Message != "missing <key> & file" || body.RequestId != "id&<value>" || rec.Code != 404 {
		t.Fatalf("unexpected error response: %+v", body)
	}
}

func TestS3PutContentLength(t *testing.T) {
	for _, tc := range []struct {
		name, decoded string
		length, want  int64
	}{
		{"unknown", "", -1, -1}, {"empty", "", 0, 0}, {"normal", "", 12, 12},
		{"decoded", "8", 50, 8}, {"invalid decoded", "oops", 50, -1}, {"negative decoded", "-1", 50, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("PUT", "/bucket/key", nil)
			req.ContentLength = tc.length
			if tc.decoded != "" {
				req.Header.Set("X-Amz-Decoded-Content-Length", tc.decoded)
			}
			got := s3PutContentLength(echo.New().NewContext(req, httptest.NewRecorder()))
			if got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}
