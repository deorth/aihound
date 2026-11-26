// node --test test/
// Checks the provenance-metadata detector against the generated fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { detectMetadata } from '../src/providers/metadata.js';

const dir = new URL('./site/fixtures/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));

const detect = async (url) => detectMetadata(new Blob([await readFile(url)]));

for (const c of manifest.filter((c) => c.kind === 'img' && !c.file.endsWith('.svg'))) {
  const shouldHit = c.group === 'Metadata' && c.expect === 'flag';
  test(`${c.file}: metadata ${shouldHit ? 'detected' : 'not detected'}`, async () => {
    const hit = await detect(new URL(c.file, dir));
    assert.equal(!!hit, shouldHit, `got ${JSON.stringify(hit)}`);
  });
}

const external = new URL('external/', dir);
if (existsSync(external)) {
  const files = await readdir(external, { recursive: true });
  for (const f of files.filter((f) => f.split('/').pop().startsWith('adobe-20220124'))) {
    test(`external/${f}: C2PA without AI source type is not flagged`, async () => {
      assert.equal(await detect(new URL(f, external)), null);
    });
  }
}
