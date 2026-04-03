/**
 * XML utility functions — shared by S3Service, S3MultipartService, and any
 * future module that needs to build or parse XML responses.
 */

/** Escape special XML characters in a string. */
export function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Decode standard XML entities back to their character equivalents. */
export function decodeXmlEntities(str: string): string {
  return String(str).replace(/&(lt|gt|quot|apos|amp);/g, (entity) => {
    switch (entity) {
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      case '&amp;':
        return '&';
      default:
        return entity;
    }
  });
}
