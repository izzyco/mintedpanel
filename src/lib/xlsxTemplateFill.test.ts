import { describe, expect, it } from "vitest";
import {
  fillXlsxTemplateBytes,
  inspectXlsxTemplate,
  type XlsxColumnMapping,
} from "./xlsxTemplateFill";
import { isXlsxPayerForm, payerFormFileError, PAYER_FORM_MIME_TYPES } from "./payerForms";
import { buildZip, readZip } from "./xlsxZip";

const BCBSKC_COLUMNS = [
  "Provider NPI",
  "Last Name",
  "First Name",
  "Middle Name",
  "Practitioner Type",
  "Degree Type",
  "Gender",
  "CAQH #",
  "Primary Specialty",
  "Primary Taxonomy Code",
  "Provider Type\n(P = PCP\nS=Specialist)",
  "Supervising Physician Name\n(Mid-level only)",
  "Supervising Physician NPI\n(Mid-level only)",
  "Supervising Physician Specialty\n(Mid-level only)",
  "Group Name",
  "Group TIN",
  "Group Type2 NPI",
  "Address Type",
  "Address Line 1",
  "Address Line 2",
  "Address City",
  "Address County",
  "Address State",
  "Address Zip",
  "Telehealth Only\n(Y/N)",
] as const;

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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createBcbskcTemplateFixture(): Uint8Array {
  const files = new Map<string, Uint8Array>();
  const textEncoder = new TextEncoder();

  files.set(
    "[Content_Types].xml",
    textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
  );

  files.set(
    "_rels/.rels",
    textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
  );

  files.set(
    "xl/_rels/workbook.xml.rels",
    textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`),
  );

  files.set(
    "xl/workbook.xml",
    textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Instructions" sheetId="1" r:id="rId1"/>
    <sheet name="PROVIDER Information" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`),
  );

  const instructionsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Complete this template using the PROVIDER Information tab</t></is></c>
    </row>
    <row r="4">
      <c r="A4" t="inlineStr"><is><t>PracticeType</t></is></c>
      <c r="C4" t="inlineStr"><is><t>PractitionerTypeName</t></is></c>
    </row>
  </sheetData>
</worksheet>`;
  files.set("xl/worksheets/sheet1.xml", textEncoder.encode(instructionsXml));

  const headerCells = BCBSKC_COLUMNS.map((col, idx) => {
    const cellRef = `${cellColumnName(idx + 1)}1`;
    return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(col)}</t></is></c>`;
  }).join("");

  const providerInfoXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:Y1"/>
  <sheetData>
    <row r="1">${headerCells}</row>
  </sheetData>
  <dataValidations count="2">
    <dataValidation type="list" allowBlank="1" sqref="E2:E500">
      <formula1>Instructions!$C$5:$C$48</formula1>
    </dataValidation>
    <dataValidation type="list" allowBlank="1" sqref="G2:G500">
      <formula1>&quot;Male,Female,Other&quot;</formula1>
    </dataValidation>
  </dataValidations>
</worksheet>`;
  files.set("xl/worksheets/sheet2.xml", textEncoder.encode(providerInfoXml));

  return buildZip(files, true);
}

function putXml(files: Map<string, Uint8Array>, path: string, xml: string): void {
  files.set(path, new TextEncoder().encode(xml));
}

/** One-sheet workbook whose header cells are shared-string indexes, as Excel writes them. */
function createSharedStringRoster(): Uint8Array {
  const files = new Map<string, Uint8Array>();
  putXml(
    files,
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
  );
  putXml(
    files,
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  putXml(
    files,
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
  );
  putXml(
    files,
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Roster" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
  );
  putXml(
    files,
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>Provider NPI</t></si>
  <si><t>Last Name</t></si>
</sst>`,
  );
  putXml(
    files,
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B1"/>
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
  </sheetData>
</worksheet>`,
  );
  return buildZip(files, true);
}

/** Header is inline rich text: two runs, the second holding a numeric newline. */
function createRichTextHeaderRoster(): Uint8Array {
  const files = new Map<string, Uint8Array>();
  putXml(
    files,
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
  );
  putXml(
    files,
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  putXml(
    files,
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
  );
  putXml(
    files,
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Roster" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
  );
  putXml(
    files,
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><r><t>Provider Type</t></r><r><t xml:space="preserve">&#10;(P = PCP)</t></r></is></c>
    </row>
  </sheetData>
</worksheet>`,
  );
  return buildZip(files, true);
}

describe("xlsxTemplateFill", () => {
  const standardMappings: XlsxColumnMapping[] = [
    { header: "Provider NPI", token: "provider.npi" },
    { header: "Last Name", token: "provider.lastName" },
    { header: "First Name", token: "provider.firstName" },
    { header: "Middle Name", token: "provider.middleName" },
    { header: "Practitioner Type", token: "provider.practitionerType" },
    { header: "Degree Type", token: "provider.credentials" },
    {
      header: "Gender",
      token: "provider.gender",
      transform: (val) => (val.toLowerCase().startsWith("m") ? "Male" : "Female"),
    },
    { header: "CAQH #", token: "provider.caqhId" },
    { header: "Primary Specialty", token: "provider.specialty" },
    { header: "Primary Taxonomy Code", token: "provider.taxonomyCode" },
    {
      header: "Provider Type\n(P = PCP\nS=Specialist)",
      token: "provider.isPcp",
      transform: (val) => (val === "true" || val === "P" ? "P" : "S"),
    },
    { header: "Supervising Physician Name\n(Mid-level only)", token: "supervisor.name" },
    { header: "Supervising Physician NPI\n(Mid-level only)", token: "supervisor.npi" },
    { header: "Supervising Physician Specialty\n(Mid-level only)", token: "supervisor.specialty" },
    { header: "Group Name", token: "group.name" },
    { header: "Group TIN", token: "group.tin" },
    { header: "Group Type2 NPI", token: "group.npiType2" },
    { header: "Address Type", fixedValue: "Remit" },
    { header: "Address Line 1", token: "group.remitStreet" },
    { header: "Address Line 2", token: "group.remitSuite" },
    { header: "Address City", token: "group.remitCity" },
    { header: "Address County", token: "group.remitCounty" },
    { header: "Address State", token: "group.remitState" },
    { header: "Address Zip", token: "group.remitZip" },
    { header: "Telehealth Only\n(Y/N)", fixedValue: "N" },
  ];

  it("inspects template sheets and detects header columns", () => {
    const fixtureBytes = createBcbskcTemplateFixture();
    const inspection = inspectXlsxTemplate(fixtureBytes);

    expect(inspection.sheets).toEqual(["Instructions", "PROVIDER Information"]);
    expect(inspection.targetSheet).toBe("PROVIDER Information");
    expect(inspection.headers.length).toBe(25);
    expect(inspection.headers[0]).toBe("Provider NPI");
    expect(inspection.headers[24]).toBe("Telehealth Only\n(Y/N)");
  });

  it("prefills MD Physician case (22/25 filled, 3 supervisor fields honest blank)", () => {
    const fixtureBytes = createBcbskcTemplateFixture();
    const physicianData: Record<string, unknown> = {
      "provider.npi": "1234567890",
      "provider.lastName": "Doe",
      "provider.firstName": "Jane",
      "provider.middleName": "A",
      "provider.practitionerType": "Medical Doctor",
      "provider.credentials": "MD",
      "provider.gender": "female",
      "provider.caqhId": "98765432",
      "provider.specialty": "Family Medicine",
      "provider.taxonomyCode": "207Q00000X",
      "provider.isPcp": "P",
      "group.name": "Kansas City Health Partners LLC",
      "group.tin": "43-1234567",
      "group.npiType2": "1987654321",
      "group.remitStreet": "2301 Holmes St",
      "group.remitSuite": "Suite 400",
      "group.remitCity": "Kansas City",
      "group.remitCounty": "Jackson",
      "group.remitState": "MO",
      "group.remitZip": "64108",
    };

    const result = fillXlsxTemplateBytes(fixtureBytes, [physicianData], standardMappings);

    expect(result.fieldsFilled).toBe(22);
    expect(result.rowCount).toBe(1);

    const filledZip = readZip(result.output);
    const sheet2Xml = filledZip.readText("xl/worksheets/sheet2.xml")!;

    expect(sheet2Xml).toContain('<dimension ref="A1:Y2"/>');
    expect(sheet2Xml).toContain('<c r="A2" t="inlineStr"><is><t>1234567890</t></is></c>');
    expect(sheet2Xml).toContain('<c r="B2" t="inlineStr"><is><t>Doe</t></is></c>');
    expect(sheet2Xml).toContain('<c r="G2" t="inlineStr"><is><t>Female</t></is></c>');
    expect(sheet2Xml).toContain('<c r="R2" t="inlineStr"><is><t>Remit</t></is></c>');
    expect(sheet2Xml).toContain('<c r="Y2" t="inlineStr"><is><t>N</t></is></c>');

    // Data validations remain uncorrupted
    expect(sheet2Xml).toContain("<dataValidations");
    expect(sheet2Xml).toContain("Instructions!$C$5:$C$48");
    expect(sheet2Xml).toContain("&quot;Male,Female,Other&quot;");

    // Instructions sheet is untouched
    const sheet1Xml = filledZip.readText("xl/worksheets/sheet1.xml")!;
    expect(sheet1Xml).toContain("Complete this template using the PROVIDER Information tab");
  });

  it("prefills mid-level NP case with supervisor data (24-25/25 filled)", () => {
    const fixtureBytes = createBcbskcTemplateFixture();
    const npData: Record<string, unknown> = {
      "provider.npi": "1999999999",
      "provider.lastName": "Adams",
      "provider.firstName": "Mark",
      "provider.practitionerType": "Nurse Practitioner",
      "provider.credentials": "NP",
      "provider.gender": "male",
      "provider.caqhId": "11223344",
      "provider.specialty": "Family Medicine",
      "provider.taxonomyCode": "363LF0000X",
      "provider.isPcp": "P",
      "supervisor.name": "Jane Doe",
      "supervisor.npi": "1234567890",
      "supervisor.specialty": "Family Medicine",
      "group.name": "Kansas City Health Partners LLC",
      "group.tin": "43-1234567",
      "group.npiType2": "1987654321",
      "group.remitStreet": "2301 Holmes St",
      "group.remitCity": "Kansas City",
      "group.remitCounty": "Jackson",
      "group.remitState": "MO",
      "group.remitZip": "64108",
    };

    const result = fillXlsxTemplateBytes(fixtureBytes, [npData], standardMappings);
    expect(result.fieldsFilled).toBe(23); // middleName and suite empty

    const filledZip = readZip(result.output);
    const sheet2Xml = filledZip.readText("xl/worksheets/sheet2.xml")!;
    expect(sheet2Xml).toContain('<c r="L2" t="inlineStr"><is><t>Jane Doe</t></is></c>');
    expect(sheet2Xml).toContain('<c r="M2" t="inlineStr"><is><t>1234567890</t></is></c>');
  });

  it("scales to multiple rows for multi-location providers", () => {
    const fixtureBytes = createBcbskcTemplateFixture();
    const row1 = {
      "provider.npi": "1234567890",
      "provider.lastName": "Doe",
      "provider.firstName": "Jane",
      "provider.middleName": "A",
      "provider.practitionerType": "Medical Doctor",
      "provider.credentials": "MD",
      "provider.gender": "female",
      "provider.caqhId": "98765432",
      "provider.specialty": "Family Medicine",
      "provider.taxonomyCode": "207Q00000X",
      "provider.isPcp": "P",
      "group.name": "Kansas City Health Partners LLC",
      "group.tin": "43-1234567",
      "group.npiType2": "1987654321",
      "group.remitStreet": "2301 Holmes St",
      "group.remitSuite": "Suite 400",
      "group.remitCity": "Kansas City",
      "group.remitCounty": "Jackson",
      "group.remitState": "MO",
      "group.remitZip": "64108",
    };
    const row2 = {
      ...row1,
      "group.remitStreet": "1000 E 101st Terrace",
      "group.remitSuite": "",
      "group.remitZip": "64131",
    };

    const result = fillXlsxTemplateBytes(fixtureBytes, [row1, row2], standardMappings);
    expect(result.rowCount).toBe(2);
    expect(result.fieldsFilled).toBe(43);

    const filledZip = readZip(result.output);
    const sheet2Xml = filledZip.readText("xl/worksheets/sheet2.xml")!;
    expect(sheet2Xml).toContain('<dimension ref="A1:Y3"/>');
    expect(sheet2Xml).toContain('<c r="S2" t="inlineStr"><is><t>2301 Holmes St</t></is></c>');
    expect(sheet2Xml).toContain('<c r="S3" t="inlineStr"><is><t>1000 E 101st Terrace</t></is></c>');
  });

  it("supports XLSX files in payerForms MIME checks and isXlsxPayerForm helper", () => {
    expect(isXlsxPayerForm("roster.xlsx")).toBe(true);
    expect(isXlsxPayerForm("form.pdf")).toBe(false);
    expect(isXlsxPayerForm(null)).toBe(false);

    expect(
      PAYER_FORM_MIME_TYPES.includes(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);

    const validXlsx = {
      size: 50_000,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: "bcbskc_roster.xlsx",
    };
    expect(payerFormFileError(validXlsx)).toBeNull();

    const emptyXlsx = {
      size: 0,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: "empty.xlsx",
    };
    expect(payerFormFileError(emptyXlsx)).toBe("That file is empty");

    const unsupportedDoc = {
      size: 50_000,
      type: "application/msword",
      name: "document.doc",
    };
    expect(payerFormFileError(unsupportedDoc)).toBe(
      "Payer forms must be PDF or Excel (.xlsx) files",
    );

    // Risk: stored-form reimport classifies the file from the signed URL.
    // Supabase signed URLs keep the object name, then append ?token=.
    expect(
      isXlsxPayerForm(
        "https://example.supabase.co/storage/v1/object/sign/payer-forms/org/roster.xlsx?token=abc.def",
      ),
    ).toBe(true);
    expect(
      isXlsxPayerForm(
        "https://example.supabase.co/storage/v1/object/sign/payer-forms/org/form.pdf?token=roster.xlsx",
      ),
    ).toBe(false);
  });

  it("reads header text stored in the shared-string table (Excel's default)", () => {
    const bytes = createSharedStringRoster();
    const inspection = inspectXlsxTemplate(bytes);
    expect(inspection.headers).toEqual(["Provider NPI", "Last Name"]);

    const result = fillXlsxTemplateBytes(
      bytes,
      [{ "provider.npi": "1234567890", "provider.lastName": "Doe" }],
      [
        { header: "Provider NPI", token: "provider.npi" },
        { header: "Last Name", token: "provider.lastName" },
      ],
    );
    expect(result.fieldsFilled).toBe(2);
    const sheet = readZip(result.output).readText("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("<t>1234567890</t>");
    expect(sheet).toContain("<t>Doe</t>");
  });

  it("joins every text run in a wrapped header, including numeric character references", () => {
    const bytes = createRichTextHeaderRoster();
    const inspection = inspectXlsxTemplate(bytes);
    expect(inspection.headers).toEqual(["Provider Type\n(P = PCP)"]);

    const result = fillXlsxTemplateBytes(
      bytes,
      [{ "provider.practitionerType": "Medical Doctor" }],
      [{ header: "Provider Type\n(P = PCP)", token: "provider.practitionerType" }],
    );
    expect(result.fieldsFilled).toBe(1);
    const sheet = readZip(result.output).readText("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("<t>Medical Doctor</t>");
  });
});
