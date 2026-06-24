#!/usr/bin/env node
/** 최소 유효 DOCX(OOXML ZIP) 생성 — docx-preview 스모크용. 검색어: WORDMARK */
import JSZip from 'jszip'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>싹싹김치 한글뷰어 — Word 테스트 문서</w:t></w:r></w:p>
    <w:p><w:r><w:t>This is a DOCX rendering smoke test. Search target: WORDMARK.</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">표와 서식은 docx-preview 가 처리합니다. 한글/English 혼용 렌더링 확인.</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`

const zip = new JSZip()
zip.file('[Content_Types].xml', contentTypes)
zip.file('_rels/.rels', rels)
zip.file('word/document.xml', documentXml)

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
const dir = join(process.cwd(), 'tests', 'fixtures')
await mkdir(dir, { recursive: true })
const out = join(dir, 'sample.docx')
await writeFile(out, buf)
console.log('[fixture] wrote', out, `(${buf.length} bytes)`)
