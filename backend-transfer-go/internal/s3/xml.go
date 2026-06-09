package s3

import (
	"encoding/xml"
	"net/url"
	"strings"
	"time"
)

const S3XmlNamespace = "http://s3.amazonaws.com/doc/2006-03-01/"

// XML Header helper
func marshalS3Xml(val interface{}) ([]byte, error) {
	data, err := xml.Marshal(val)
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), data...), nil
}

// 1. ListBuckets XML definition
type ListAllMyBucketsResult struct {
	XMLName xml.Name `xml:"ListAllMyBucketsResult"`
	Xmlns   string   `xml:"xmlns,attr"`
	Owner   Owner    `xml:"Owner"`
	Buckets Buckets  `xml:"Buckets"`
}

type Owner struct {
	ID          string `xml:"ID"`
	DisplayName string `xml:"DisplayName"`
}

type Buckets struct {
	Bucket []BucketXML `xml:"Bucket"`
}

type BucketXML struct {
	Name         string `xml:"Name"`
	CreationDate string `xml:"CreationDate"` // ISO 8601 string
}

// 2. ListObjectsV2 XML definition
type ListBucketResult struct {
	XMLName        xml.Name          `xml:"ListBucketResult"`
	Xmlns          string            `xml:"xmlns,attr"`
	Name           string            `xml:"Name"`
	Prefix         string            `xml:"Prefix"`
	KeyCount       int               `xml:"KeyCount"`
	MaxKeys        int               `xml:"MaxKeys"`
	Delimiter      string            `xml:"Delimiter,omitempty"`
	EncodingType   string            `xml:"EncodingType,omitempty"`
	IsTruncated    bool              `xml:"IsTruncated"`
	Contents       []ObjectContentXML `xml:"Contents,omitempty"`
	CommonPrefixes []CommonPrefixXML `xml:"CommonPrefixes,omitempty"`
}

type ObjectContentXML struct {
	Key          string    `xml:"Key"`
	LastModified string    `xml:"LastModified"` // ISO 8601 string
	ETag         string    `xml:"ETag"`
	Size         int64     `xml:"Size"`
	StorageClass string    `xml:"StorageClass"`
}

type CommonPrefixXML struct {
	Prefix string `xml:"Prefix"`
}

// 3. DeleteObjects XML input and result
type DeleteInput struct {
	XMLName xml.Name      `xml:"Delete"`
	Quiet   bool          `xml:"Quiet"`
	Objects []DeleteObject `xml:"Object"`
}

type DeleteObject struct {
	Key string `xml:"Key"`
}

type DeleteResult struct {
	XMLName xml.Name      `xml:"DeleteResult"`
	Xmlns   string        `xml:"xmlns,attr"`
	Deleted []DeletedXML  `xml:"Deleted,omitempty"`
	Errors  []DeleteError `xml:"Error,omitempty"`
}

type DeletedXML struct {
	Key string `xml:"Key"`
}

type DeleteError struct {
	Key     string `xml:"Key"`
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
}

// 4. CopyObjectResult XML
type CopyObjectResult struct {
	XMLName      xml.Name `xml:"CopyObjectResult"`
	Xmlns        string   `xml:"xmlns,attr"`
	LastModified string   `xml:"LastModified"`
	ETag         string   `xml:"ETag"`
}

// 5. InitiateMultipartUploadResult XML
type InitiateMultipartUploadResult struct {
	XMLName  xml.Name `xml:"InitiateMultipartUploadResult"`
	Xmlns    string   `xml:"xmlns,attr"`
	Bucket   string   `xml:"Bucket"`
	Key      string   `xml:"Key"`
	UploadId string   `xml:"UploadId"`
}

// 6. CompleteMultipartUpload XML input and result
type CompleteMultipartUploadInput struct {
	XMLName xml.Name              `xml:"CompleteMultipartUpload"`
	Parts   []CompletePartInput   `xml:"Part"`
}

type CompletePartInput struct {
	PartNumber int    `xml:"PartNumber"`
	ETag       string `xml:"ETag"`
}

type CompleteMultipartUploadResult struct {
	XMLName  xml.Name `xml:"CompleteMultipartUploadResult"`
	Xmlns    string   `xml:"xmlns,attr"`
	Location string   `xml:"Location"`
	Bucket   string   `xml:"Bucket"`
	Key      string   `xml:"Key"`
	ETag     string   `xml:"ETag"`
}

// 7. ListPartsResult XML
type ListPartsResult struct {
	XMLName     xml.Name      `xml:"ListPartsResult"`
	Xmlns       string        `xml:"xmlns,attr"`
	Bucket      string        `xml:"Bucket"`
	Key         string        `xml:"Key"`
	UploadId    string        `xml:"UploadId"`
	IsTruncated bool          `xml:"IsTruncated"`
	Parts       []ListPartXML `xml:"Part,omitempty"`
}

type ListPartXML struct {
	PartNumber   int    `xml:"PartNumber"`
	Size         int64  `xml:"Size"`
	ETag         string `xml:"ETag"`
	LastModified string `xml:"LastModified"`
}

// 8. S3 Error XML
type S3ErrorResponse struct {
	XMLName xml.Name `xml:"Error"`
	Code    string   `xml:"Code"`
	Message string   `xml:"Message"`
}

// URL-encoding for S3 keys when encoding-type=url is requested
func encodeS3Key(key string, encodingType string) string {
	if encodingType != "url" {
		return key
	}
	escaped := url.QueryEscape(key)
	// Match AWS specifics
	escaped = strings.ReplaceAll(escaped, "+", "%20")
	escaped = strings.ReplaceAll(escaped, "*", "%2A")
	return escaped
}

func formatISO8601(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
