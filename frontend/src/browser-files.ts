/** Start a browser download and release its temporary DOM and URL resources. */
export function downloadFile(filename: string, content: BlobPart, { type = 'application/octet-stream', revokeAfterMs = 30_000 }: { type?: string; revokeAfterMs?: number } = {}): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  try { document.body.append(link); link.click(); }
  finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs); }
}
