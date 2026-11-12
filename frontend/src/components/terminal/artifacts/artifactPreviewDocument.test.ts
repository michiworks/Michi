import { describe, it, expect } from 'vitest';
import { ARTIFACT_PREVIEW_CSP, artifactPreviewSrcdoc } from './artifactPreviewDocument';

describe('artifactPreviewSrcdoc', () => {
  it('puts the policy first, ahead of anything from the page', () => {
    const doc = artifactPreviewSrcdoc('<!DOCTYPE html>\n<html><head><script>alert(1)</script>');
    expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}">`)).toBe(true);
    // One doctype, and the page's markup follows the shims untouched.
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc.endsWith('\n<html><head><script>alert(1)</script>')).toBe(true);
  });

  it('drops a byte-order mark with the doctype', () => {
    expect(artifactPreviewSrcdoc('\uFEFF<!doctype html><p>x</p>').endsWith('</script><p>x</p>')).toBe(true);
  });

  it('keeps a page without a doctype as it is', () => {
    expect(artifactPreviewSrcdoc('<p>plain</p>').endsWith('</script><p>plain</p>')).toBe(true);
  });

  it('takes the network away and leaves scripts and inline assets', () => {
    const directives = new Map(ARTIFACT_PREVIEW_CSP.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name, values] as const;
    }));
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('connect-src')).toEqual(['data:', 'blob:']);
    expect(directives.get('img-src')).toEqual(['data:', 'blob:']);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    for (const values of directives.values()) {
      expect(values.some((v) => /^(https?:|\*|'self')/.test(v))).toBe(false);
    }
  });
});
