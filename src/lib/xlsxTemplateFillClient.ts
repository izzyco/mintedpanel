// CLIENT-ONLY XLSX template fill download helper.
// Matches the download contract of payerFormFillClient.ts.

/**
 * Hand the filled .xlsx bytes to the coordinator as a local download.
 * PHI stays in the browser and never lands in server buckets.
 */
export function downloadXlsxOutput(output: Uint8Array, fileName: string): void {
  const blob = new Blob([output as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
