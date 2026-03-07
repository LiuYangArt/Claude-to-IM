import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('delivery-layer import lifecycle', () => {
  it('importing delivery-layer does not keep process alive', () => {
    const modulePath = path.resolve(process.cwd(), 'src/lib/bridge/delivery-layer.ts');
    const script = [
      'import { pathToFileURL } from "node:url";',
      `await import(pathToFileURL(${JSON.stringify(modulePath)}).href);`,
      'console.log("imported");',
    ].join('\n');

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 4000,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /imported/);
  });
});
