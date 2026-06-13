package s3auth

import "time"

// parseAmzDate parses the X-Amz-Date format: YYYYMMDDTHHMMSSZ.
// Returns ErrMalformed if the value is the wrong length or unparseable.
func parseAmzDate(s string) (time.Time, error) {
	if len(s) != 16 {
		return time.Time{}, ErrMalformed
	}
	t, err := time.Parse("20060102T150405Z", s)
	if err != nil {
		return time.Time{}, ErrMalformed
	}
	return t, nil
}
