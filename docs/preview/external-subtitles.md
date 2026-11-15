# External subtitles in video previews

Every PreviewVideo surface (private modal, full preview page, file share, folder share) has one captions button in xgplayer's right control grid, mounted through a React portal. It follows the player's control visibility. Clicking it opens an overlay menu for Open from device, Open from Tele-Drive, the selected filename and the subtitle toggle; there is no separate toolbar below the video. The menu/picker are React siblings of the player so xgplayer's global child CSS does not reset their styles. Both remain inside the fullscreen target. Escape/backdrop dismiss the menu and restore focus; keyboard events do not reach the outer preview. Native iOS video-only fullscreen can expose browser subtitle controls rather than this custom menu.

## Sources and authorization

- Local .srt/.vtt files are read only in the browser, never uploaded.
- The Tele-Drive picker searches the signed-in viewer's own library through the existing `searchFiles` shared API. Guests can use local files; the library button requires authentication. Public folder access is not expanded into access to the owner's private library.
- Search is global, debounced, and filters filenames by the selected extension. Only the file cursor is used because requests specify `type=file`. Filtering may leave a page empty with more pages still available; Load more remains available.
- Only complete/buffered files are selectable. `getPreviewUrl` reuses existing authorization and runtime transfer-origin resolution. The resulting signed URL is fetched without cookies or Authorization headers. This still uses the normal server bandwidth accounting.
- Both local and remote subtitles are capped at 10 MiB. Remote reads check content-length and cumulative streamed bytes. Cancelling/replacing a request aborts the stream; network reads use the shared API timeout value.

## Rendering and lifetime

`lib/subtitles.ts` validates cue timing and converts SRT comma timestamps to WebVTT. UTF-8 is the supported encoding. WebVTT cue settings and metadata blocks are retained. Files require at least one timed cue. SRT-specific positioning extensions are not preserved.

The normalized text becomes a temporary text/vtt Blob URL attached as a native HTML track to xgplayer's video. Subtitle strings are never inserted with innerHTML. The browser handles WebVTT cue markup. Invalid file/transfer errors leave the previous subtitle available; native parser errors are reported in the toolbar.

Subtitle state lives outside the xgplayer instance so signed-video-URL renewal reattaches the track and preserves the on/off setting. Each preview renderer is keyed by the video file identity, preventing subtitles and playback state leaking to another video. Blob URLs, track listeners, and pending loads are cleaned up when replaced or unmounted. Closing the preview forgets its subtitle selection.

This feature loads external text subtitles; it does not extract embedded tracks or support ASS/PGS/VobSub.

## Checks

Focused tests cover SRT/VTT normalization, invalid content/size, search pagination and stale requests, selection availability, dialog keyboard behavior, replacement races and unmount cancellation. Run frontend lint, typecheck, tests, and production build after changes. A browser smoke check should verify visible cues, seek alignment, toggling, signed URL renewal, fullscreen, local selection and an authenticated library transfer.
