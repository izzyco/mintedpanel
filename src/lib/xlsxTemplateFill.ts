import { readZip } from "./xlsxZip";

export interface XlsxColumnMapping {
  /** The header text as it appears in the template (e.g. "Provider NPI") */
  header: string;
  /** The token to resolve from the payload, or null if fixed */
  token?: string | null;
  /** Fixed value literal if this column always takes a constant */
  fixedValue?: string | null;
  /** Transform function (e.g. uppercase, format phone/TIN, map dropdown) */
  transform?: (val: string, rowContext: Record<string, unknown>) => string;
}

export interface XlsxFillResult {
  output: Uint8Array;
  fieldsFilled: number;
  fieldsSkipped: Array<{ column: string; reason: "unmapped" | "no_value" }>;
  rowCount: number;
}

export interface XlsxTemplateInspection {
  sheets: string[];
  targetSheet: string;
  headers: string[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cellColumnName(colIndex: number): string {
  let current = colIndex;
  let out = "";
  while (current > 0) {
    const rem = (current - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    current = Math.floor((current - 1) / 26);
  }
  return out;
}

/**
 * Extracts plain text from an XML element or inline string tag `<is><t>...</t></is>`.
 */
function extractCellText(cellXml: string): string {
  const match = /<t[^>]*>([^<]*)<\/t>/.exec(cellXml);
  return match
    ? match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
    : "";
}

/**
 * Resolves the worksheet XML path for a given sheet name from workbook.xml and workbook.xml.rels.
 */
function resolveSheetPath(
  zip: ReturnType<typeof readZip>,
  sheetName?: string,
): { path: string; resolvedName: string } {
  const workbookXml = zip.readText("xl/workbook.xml");
  const relsXml = zip.readText("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) {
    throw new Error("Invalid XLSX: missing xl/workbook.xml or xl/_rels/workbook.xml.rels");
  }

  // Find all sheets in workbook.xml
  const sheetMatches = Array.from(
    workbookXml.matchAll(/<sheet[^>]*name=["']([^"']+)["'][^>]*r:id=["']([^"']+)["']/gi),
  );
  if (sheetMatches.length === 0) {
    return { path: "xl/worksheets/sheet1.xml", resolvedName: "Sheet1" };
  }

  let selectedMatch = sheetMatches[0];
  if (sheetName) {
    const found = sheetMatches.find((m) => m[1].toLowerCase() === sheetName.toLowerCase());
    if (found) selectedMatch = found;
  } else if (sheetMatches.length > 1) {
    // If multiple sheets and target not specified, look for sheets with "provider", "roster", or the second sheet
    const likely = sheetMatches.find((m) => /provider|roster|data/i.test(m[1]));
    if (likely) selectedMatch = likely;
    else selectedMatch = sheetMatches[1]; // default to 2nd sheet (e.g. Tab 2 after Instructions)
  }

  const resolvedName = selectedMatch[1];
  const rId = selectedMatch[2];

  const relRegex = new RegExp(
    `<Relationship[^>]*Id=["']${rId}["'][^>]*Target=["']([^"']+)["']`,
    "i",
  );
  const relMatch = relRegex.exec(relsXml);
  if (!relMatch) {
    return { path: "xl/worksheets/sheet1.xml", resolvedName };
  }

  const target = relMatch[1];
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  return { path, resolvedName };
}

/**
 * Inspect an uploaded blank .xlsx template to extract its sheet list and header row columns.
 */
export function inspectXlsxTemplate(
  templateBytes: Uint8Array,
  targetSheetName?: string,
): XlsxTemplateInspection {
  const zip = readZip(templateBytes);
  const workbookXml = zip.readText("xl/workbook.xml") ?? "";
  const sheets = Array.from(workbookXml.matchAll(/<sheet[^>]*name=["']([^"']+)["']/gi)).map(
    (m) => m[1],
  );

  const { path: sheetPath, resolvedName: targetSheet } = resolveSheetPath(zip, targetSheetName);
  const sheetXml = zip.readText(sheetPath) ?? "";

  const headers: string[] = [];
  const rowMatch = /<row[^>]*r=["']?1["']?[^>]*>(.*?)<\/row>/s.exec(sheetXml);
  if (rowMatch) {
    const cellRegex = /<c\s+r=["']([A-Z]+)1["'][^>]*>(.*?)<\/c>/gs;
    let match: RegExpExecArray | null;
    while ((match = cellRegex.exec(rowMatch[1])) !== null) {
      const text = extractCellText(match[2]).trim();
      if (text) headers.push(text);
    }
  }

  return { sheets, targetSheet, headers };
}

/**
 * Pure, client-safe Excel Template Filler.
 * Ingests blank `.xlsx` bytes, locates the target sheet and header row,
 * populates provider data rows into `<sheetData>`, updates dimensions,
 * and preserves all data validations, formulas, styles, and other sheets.
 */
export function fillXlsxTemplateBytes(
  templateBytes: Uint8Array,
  records: Array<Record<string, unknown>>,
  mappings: XlsxColumnMapping[],
  options?: { targetSheetName?: string },
): XlsxFillResult {
  const zip = readZip(templateBytes);
  const { path: sheetPath, resolvedName } = resolveSheetPath(zip, options?.targetSheetName);
  const sheetXml = zip.readText(sheetPath);

  if (!sheetXml) {
    throw new Error(`Target sheet '${resolvedName}' not found at ${sheetPath} in template.`);
  }

  // 1. Locate `<sheetData>` and parse the header row
  const sheetDataStart = sheetXml.indexOf("<sheetData>");
  const sheetDataEnd = sheetXml.indexOf("</sheetData>");
  if (sheetDataStart === -1 || sheetDataEnd === -1) {
    throw new Error("Invalid sheet XML: missing <sheetData> block.");
  }

  const sheetDataContent = sheetXml.substring(sheetDataStart + "<sheetData>".length, sheetDataEnd);

  // Extract first row: `<row r="1">...</row>`
  const rowMatch = /<row[^>]*r=["']?1["']?[^>]*>(.*?)<\/row>/s.exec(sheetDataContent);
  if (!rowMatch) {
    throw new Error("Could not find header row (row 1) in worksheet.");
  }

  const headerRowInner = rowMatch[1];
  const cellRegex = /<c\s+r=["']([A-Z]+)1["'][^>]*>(.*?)<\/c>/gs;
  const colIndexMap = new Map<string, number>(); // Header Name -> Column Number (1-based)
  const colLetterMap = new Map<number, string>(); // Column Number -> Col Letter (e.g. 1 -> 'A')

  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(headerRowInner)) !== null) {
    const colLetter = match[1];
    const cellContent = match[2];
    const headerText = extractCellText(cellContent).trim();

    // Convert col letter to index (A -> 1, B -> 2, etc.)
    let colNum = 0;
    for (let i = 0; i < colLetter.length; i++) {
      colNum = colNum * 26 + (colLetter.charCodeAt(i) - 64);
    }

    colLetterMap.set(colNum, colLetter);
    colIndexMap.set(headerText, colNum);
  }

  // 2. Prepare mapping index
  const mappingByHeader = new Map<string, XlsxColumnMapping>();
  for (const m of mappings) {
    mappingByHeader.set(m.header.trim(), m);
  }

  // 3. Build data rows
  let fieldsFilled = 0;
  const fieldsSkipped: Array<{ column: string; reason: "unmapped" | "no_value" }> = [];
  const newRowsXml: string[] = [];

  for (let recIdx = 0; recIdx < records.length; recIdx++) {
    const record = records[recIdx];
    const rowNumber = recIdx + 2; // Data rows start at Row 2 (headers at Row 1)
    const rowCells: string[] = [];

    // Iterate all discovered headers in column order
    const sortedColNums = Array.from(colLetterMap.keys()).sort((a, b) => a - b);

    for (const colNum of sortedColNums) {
      const colLetter = colLetterMap.get(colNum)!;
      const cellRef = `${colLetter}${rowNumber}`;

      // Find which header is at this column
      let headerName = "";
      for (const [h, idx] of colIndexMap.entries()) {
        if (idx === colNum) {
          headerName = h;
          break;
        }
      }

      const mapping = mappingByHeader.get(headerName);
      if (!mapping) {
        fieldsSkipped.push({ column: headerName, reason: "unmapped" });
        continue;
      }

      let value = "";
      if (mapping.fixedValue != null) {
        value = mapping.fixedValue;
      } else if (mapping.token) {
        const rawVal = record[mapping.token];
        value = rawVal != null ? String(rawVal).trim() : "";
      }

      if (mapping.transform && value !== "") {
        value = mapping.transform(value, record);
      }

      if (value === "") {
        fieldsSkipped.push({ column: headerName, reason: "no_value" });
        continue;
      }

      fieldsFilled += 1;
      rowCells.push(`<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`);
    }

    newRowsXml.push(`<row r="${rowNumber}">${rowCells.join("")}</row>`);
  }

  // 4. Assemble updated `<sheetData>`
  const existingHeaderRowXml = rowMatch[0];
  const updatedSheetData = `<sheetData>${existingHeaderRowXml}${newRowsXml.join("")}</sheetData>`;

  // 5. Update `<dimension ref="..."/>`
  const maxRow = records.length + 1;
  const maxColLetter = cellColumnName(colLetterMap.size);
  const newDimension = `<dimension ref="A1:${maxColLetter}${maxRow}"/>`;

  const updatedSheetXml = sheetXml
    .replace(/<dimension[^>]*\/>/, newDimension)
    .replace(/<sheetData>.*?<\/sheetData>/s, updatedSheetData);

  zip.writeText(sheetPath, updatedSheetXml);

  return {
    output: zip.toBytes(true),
    fieldsFilled,
    fieldsSkipped,
    rowCount: records.length,
  };
}
