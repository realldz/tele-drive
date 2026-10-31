# S3 MIME type resolution and repair

S3 clients may omit `Content-Type` or send a generic binary type. Tele-Drive
stores the resolved MIME type on `FileRecord`; HeadObject and GetObject later
return that stored value.

## Upload behavior

`resolveMimeType(filename, clientMimeType)` trusts a specific client value. It
uses the filename extension when the value is empty or one of these generic
forms, matched case-insensitively and without parameters:

- `application/octet-stream`
- `application/x-octet-stream`
- `binary/octet-stream`

For example, `Application/Octet-Stream; charset=binary` on `archive.zip`
resolves to `application/zip`. An unknown extension or extensionless filename
normally remains `application/octet-stream`. Source extensions `.smali`, `.kt`,
and `.kts` use the explicit safe fallback `text/plain` because the standard MIME
database does not define them.

When the Go S3 data plane receives a non-empty body with a generic MIME value,
it also inspects at most the first 512 decoded bytes using Go's standard content
detection. Those bytes are prepended back to the stream before hashing,
encryption, and upload. This improves unknown text and recognizable media files
without changing file contents or trusting arbitrary filename mappings.

Both the NestJS upload path and the Go S3 data plane ultimately resolve MIME in
the core service before creating the database record. Go logs the incoming
Content-Type on PutObject so operators can distinguish client metadata from the
stored resolved value.

## Repairing historical records

Records created before extension inference was introduced retain their stored
generic MIME type. The repair command only changes records whose current MIME is
generic and whose filename maps to a specific type in `mime-types`.

Dry run, which is the default:

```bash
npm run repair:mime-types
```

The command uses the compiled script in `dist`, so run `npm run build` first in
a source checkout. Production images already contain the compiled output.

Apply the reported repairs:

```bash
npm run repair:mime-types -- --apply
```

The command scans in batches and updates each row only if its MIME value has not
changed since it was read. Output is aggregate JSON and does not print filenames.
Unknown extensions remain generic and can be handled later through an explicit
extension map if their semantics are known.
