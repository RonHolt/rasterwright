import { describe, expect, it } from 'vitest';

import { classify, needsAttention } from '../../src/review/classify.js';
import { afterKey, encodePath, escapeHtml, renderPage } from '../../src/review/html.js';
import { openerFor } from '../../src/review/open.js';
import { emptyManifest } from '../../src/review/store.js';
import { encodeOperation, entry, fakeRun } from '../helpers/review.js';
import type { AfterState, RenderContext } from '../../src/review/html.js';
import type { ReviewEntry, ReviewManifest } from '../../src/types.js';

/** Every entry present and identical to what the run produced. */
function contextFor(manifest: ReviewManifest, override?: Map<string, AfterState>): RenderContext {
  const after = override ?? new Map<string, AfterState>();
  if (override === undefined) {
    for (const run of manifest.runs) {
      for (const item of run.entries) after.set(afterKey(run.runId, item.outputPath), 'present');
    }
  }
  return { after, generatedAt: new Date('2026-09-01T12:00:00Z'), storeBytes: 1024 };
}

function render(entries: ReviewEntry[], override?: Map<string, AfterState>): string {
  const manifest: ReviewManifest = { version: 1, retain: 1, runs: [fakeRun('run-1', entries)] };
  return renderPage(manifest, contextFor(manifest, override));
}

/**
 * A cheap structural check: every tag that is opened is closed, in order.
 *
 * Not a parser and not trying to be one. It catches the failure that actually
 * happens when a renderer is edited - a `</div>` dropped from one branch - and
 * it needs no DOM dependency to do it.
 */
function tagsBalance(html: string): { balanced: boolean; detail: string } {
  const VOID = new Set(['meta', 'img', 'input', 'br', 'hr', 'link', 'source']);
  const stack: string[] = [];
  const pattern = /<(\/?)([a-z0-9]+)([^>]*)>/g;
  // The script and style bodies are not markup and must not be scanned.
  const markup = html
    .replace(/<style>[\s\S]*?<\/style>/g, '<style></style>')
    .replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');

  for (let match = pattern.exec(markup); match !== null; match = pattern.exec(markup)) {
    const [, closing, name = '', attributes = ''] = match;
    if (VOID.has(name) || attributes.endsWith('/') || name === 'doctype') continue;
    if (closing === '/') {
      const open = stack.pop();
      if (open !== name) return { balanced: false, detail: `</${name}> closes <${open ?? 'nothing'}>` };
    } else {
      stack.push(name);
    }
  }

  return { balanced: stack.length === 0, detail: stack.length === 0 ? '' : `unclosed: ${stack.join(', ')}` };
}

describe('escaping', () => {
  it('escapes every character that can leave its context', () => {
    expect(escapeHtml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;');
  });

  it('encodes a path per segment, so the separators survive', () => {
    expect(encodePath('assets/my images/hero #1.jpg')).toBe('assets/my%20images/hero%20%231.jpg');
    expect(encodePath('assets/café.png')).toBe('assets/caf%C3%A9.png');
    expect(encodePath('a&b/c?d.png')).toBe('a%26b/c%3Fd.png');
  });

  it('lets nothing from a hostile path reach the markup unescaped', () => {
    const hostile = 'assets/<script>alert(1)</script>&"\'.png';
    const html = render([entry({ path: hostile, outputPath: hostile })]);

    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toMatch(/assets\/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    // And the `src` is URL-encoded on top of that, so the browser asks for the
    // file that is actually there.
    expect(html).toMatch(/src="\.\.\/\.\.\/assets\/%3Cscript%3E/);
    expect(tagsBalance(html).balanced).toBe(true);
  });
});

describe('classify', () => {
  it('says nothing about an ordinary, uneventful fix', () => {
    expect(classify(entry())).toEqual([]);
    expect(needsAttention(entry())).toBe(false);
  });

  it('flags each status', () => {
    expect(classify(entry({ status: 'failed', after: undefined }))).toContain('failed');
    expect(classify(entry({ status: 'blocked', after: undefined }))).toContain('blocked');
    expect(classify(entry({ status: 'skipped', after: undefined }))).toContain('skipped');
  });

  it('flags a rename', () => {
    expect(classify(entry({ outputPath: 'assets/hero.webp' }))).toContain('renamed');
  });

  it('flags a file that grew', () => {
    const grew = entry({
      savingsPct: -230,
      after: { bytes: 1_320_000, width: 2000, height: 1200, format: 'png', contentHash: 'c'.repeat(64) },
    });
    expect(classify(grew)).toContain('grew');
  });

  it('flags a saving too large to take on trust', () => {
    expect(classify(entry({ savingsPct: 96 }))).toContain('shrank-suspiciously');
    expect(classify(entry({ savingsPct: 95 }))).not.toContain('shrank-suspiciously');
  });

  it('flags a large saving that came out of quality alone', () => {
    expect(classify(entry({ savingsPct: 71 }))).toContain('quality-only-drop');
    // The same saving with a resize behind it is just a resize working.
    expect(classify(entry({ savingsPct: 71, applied: ['resize', 'encode'] }))).not.toContain(
      'quality-only-drop',
    );
  });

  it('flags a lossy re-encode that bought nothing', () => {
    expect(classify(entry({ savingsPct: 1 }))).toContain('barely-shrank');
    expect(classify(entry({ savingsPct: 2 }))).not.toContain('barely-shrank');
    // A lossless source has no generation loss to have wasted.
    const lossless = entry({
      savingsPct: 1,
      operations: [encodeOperation({ format: 'png', lossyReencode: false })],
    });
    expect(classify(lossless)).not.toContain('barely-shrank');
  });

  it('flags dimensions that changed with nothing in the plan to change them', () => {
    const drifted = entry({
      after: { bytes: 200_000, width: 1000, height: 600, format: 'jpeg', contentHash: 'd'.repeat(64) },
    });
    expect(classify(drifted)).toContain('dimensions-without-resize');
    expect(classify({ ...drifted, applied: ['resize', 'encode'] })).not.toContain(
      'dimensions-without-resize',
    );
  });

  it('flags an unmet ceiling from the plan and from the reason', () => {
    const refused = entry({
      status: 'failed',
      after: undefined,
      savingsPct: undefined,
      operations: [encodeOperation({ maxBytes: 200 * 1024, budgetDriven: true })],
    });
    expect(classify(refused)).toContain('unmet-budget');

    const worded = entry({
      status: 'failed',
      after: undefined,
      operations: [],
      reason: 'cannot reach 20 KB without dropping below the ceiling',
    });
    expect(classify(worded)).toContain('unmet-budget');
  });

  it('flags transparency only where it decided something', () => {
    const refused = entry({
      status: 'skipped',
      after: undefined,
      reason: 'transparency present, and JPEG cannot represent it',
    });
    expect(classify(refused)).toContain('transparency');

    // An alpha-preserving encode that succeeded made no judgement call: the
    // executor already refuses to write one that lost the alpha.
    const preserved = entry({ operations: [encodeOperation({ preserveAlpha: true })] });
    expect(classify(preserved)).not.toContain('transparency');
  });

  it('flags a write that left something outstanding', () => {
    expect(classify(entry({ warnings: ['still 1600 px wide'] }))).toContain('unresolved');
  });

  it('orders the flags by urgency, failure first', () => {
    const messy = entry({
      status: 'failed',
      outputPath: 'assets/hero.webp',
      after: undefined,
      warnings: ['still too wide'],
    });
    expect(classify(messy)[0]).toBe('failed');
  });
});

describe('renderPage', () => {
  it('produces one balanced, self-contained document with no network references', () => {
    const html = render([entry()]);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(tagsBalance(html).detail).toBe('');
    expect(html).toMatch(/<style>/);
    expect(html).toMatch(/<script>/);
    // No CDN, no font service, no data URI.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/data:image/);
  });

  it('says so explicitly when nothing needs review', () => {
    const html = render([entry()]);
    expect(html).toMatch(/Needs attention/);
    expect(html).toMatch(/Nothing needs review/);
  });

  it('puts the exceptions before the changes, failures first', () => {
    const html = render([
      entry({ path: 'assets/ordinary.jpg', outputPath: 'assets/ordinary.jpg' }),
      entry({ path: 'assets/broken.png', outputPath: 'assets/broken.png', status: 'failed', after: undefined }),
    ]);

    expect(html.indexOf('Needs attention')).toBeLessThan(html.indexOf('All changes'));
    expect(html.indexOf('assets/broken.png')).toBeLessThan(html.indexOf('assets/ordinary.jpg'));
    expect(html).not.toMatch(/Nothing needs review/);
    expect(html).not.toMatch(/This run wrote no files/);
  });

  it('points both images at files that exist relative to the page', () => {
    const html = render([entry({ path: 'assets/hero.jpg', outputPath: 'assets/hero.webp' })]);

    expect(html).toMatch(/src="before\/a{64}\.jpg"/);
    expect(html).toMatch(/src="\.\.\/\.\.\/assets\/hero\.webp"/);
    expect(html).toMatch(/loading="lazy"/);
  });

  it('notes an output that has changed since the run instead of claiming it', () => {
    const changed = new Map([[afterKey('run-1', 'assets/hero.jpg'), 'changed' as AfterState]]);
    const html = render([entry()], changed);

    expect(html).toMatch(/This file has changed since the run/);
    expect(html).toMatch(/after \(changed since\)/);
  });

  it('shows only the original when the output has gone', () => {
    const missing = new Map([[afterKey('run-1', 'assets/hero.jpg'), 'missing' as AfterState]]);
    const html = render([entry()], missing);

    expect(html).toMatch(/no longer at/);
    expect(html).toMatch(/src="before\/a{64}\.jpg"/);
    expect(html).not.toMatch(/src="\.\.\/\.\.\/assets\/hero\.jpg"/);
  });

  it('renders every retained run, newest first', () => {
    const manifest: ReviewManifest = {
      version: 1,
      retain: 2,
      runs: [
        fakeRun('newest', [entry({ path: 'assets/new.jpg', outputPath: 'assets/new.jpg' })]),
        fakeRun('older', [entry({ path: 'assets/old.jpg', outputPath: 'assets/old.jpg' })]),
      ],
    };
    const html = renderPage(manifest, contextFor(manifest));

    expect(html).toMatch(/>latest</);
    expect(html.indexOf('assets/new.jpg')).toBeLessThan(html.indexOf('assets/old.jpg'));
    expect(html).toMatch(/2 retained runs/);
  });

  it('renders an empty manifest without pretending it has content', () => {
    const html = renderPage(emptyManifest(), contextFor(emptyManifest()));
    expect(html).toMatch(/No run has been recorded yet/);
    expect(tagsBalance(html).balanced).toBe(true);
  });

  it('describes the operations and the quality the encoder actually chose', () => {
    const html = render([
      entry({
        operations: [encodeOperation({ maxBytes: 204_800, quality: { start: 82, floor: 40 } })],
        encode: {
          format: 'jpeg',
          bytes: 200_000,
          quality: { start: 82, chosen: 72, floor: 40, searched: true, attempts: 4 },
        },
      }),
    ]);

    expect(html).toMatch(/quality 82 to 72 \(searched down to 40, 4 encodes\)/);
    expect(html).toMatch(/ceiling 200 KB/);
    expect(html).toMatch(/lossy source re-encoded/);
  });
});

describe('the page after review feedback', () => {
  it('titles the zoom dialog with the pane it is showing, not the source path', () => {
    const html = render([entry({ path: 'assets/my photos/hero.jpg', outputPath: 'assets/my photos/hero.webp' })]);

    // Both names are their own attribute. Splitting one joined attribute on a
    // space would take "assets/my" as the whole path.
    expect(html).toMatch(/data-before-name="assets\/my photos\/hero\.jpg"/);
    expect(html).toMatch(/data-after-name="assets\/my photos\/hero\.webp"/);
    expect(html).toMatch(/data-pane="before"/);
    expect(html).toMatch(/data-pane="after"/);
    // And the script reads the one matching the pane.
    expect(html).toMatch(/pane === 'before' \? card\.dataset\.beforeName : card\.dataset\.afterName/);
    expect(html).not.toMatch(/dataset\.path\.split/);
  });

  it('pluralizes the verb in the pointer to the exceptions section', () => {
    const flagged = (name: string): ReviewEntry =>
      entry({ path: `assets/${name}.jpg`, outputPath: `assets/${name}.webp` });

    const one = render([flagged('a'), entry({ path: 'x.jpg', outputPath: 'x.jpg' })]);
    expect(one).toMatch(/1 other written file appears above/);

    const two = render([flagged('a'), flagged('b'), entry({ path: 'x.jpg', outputPath: 'x.jpg' })]);
    expect(two).toMatch(/2 other written files appear above/);
  });

  it('carries an empty state for a filter that matches nothing', () => {
    const html = render([entry()]);
    expect(html).toMatch(/id="no-matches" hidden/);
    expect(html).toMatch(/No file matches the current filter/);
    // Shown only when cards exist and none are visible.
    expect(html).toMatch(/empty\.hidden = cards\.length === 0 \|\| visible > 0;/);
    // And a run with no visible section is hidden along with it.
    expect(html).toMatch(/run\.hidden = !anyVisible\(run\.querySelectorAll\('\.group'\)\);/);
  });

  it('steals the / shortcut from a checkbox but not from a text field', () => {
    const html = render([entry()]);
    expect(html).toMatch(/TEXT_ENTRY = \/\^\(text\|search\|email\|url\|tel\|password\|number\)\$\//);
    expect(html).toMatch(/active\.isContentEditable \|\| active\.tagName === 'TEXTAREA'/);
    // The old guard exempted every input, the exceptions checkbox included.
    expect(html).not.toMatch(/active\.tagName === 'INPUT' \|\| active\.tagName === 'TEXTAREA'/);
  });

  it('sizes the two panes on one scale, so a resize looks like one', () => {
    const resized = entry({
      before: { bytes: 400_000, width: 700, height: 700, format: 'jpeg' },
      after: { bytes: 100_000, width: 300, height: 300, format: 'jpeg', contentHash: 'e'.repeat(64) },
      applied: ['resize', 'encode'],
    });
    const html = render([resized]);

    expect(html).toMatch(/style="--w:100%;--h:100%"/);
    expect(html).toMatch(/style="--w:42\.9%;--h:42\.9%"/);
    // The overlay compares pixels rather than sizes, so it puts both back to full.
    expect(html).toMatch(/\.card\[data-view=overlay\] \.zoom img \{ width:100%; height:100%; \}/);
  });

  it('draws the checkerboard only behind a format that can be transparent', () => {
    const png = render([
      entry({
        path: 'a.png',
        outputPath: 'a.png',
        before: { bytes: 100, width: 10, height: 10, format: 'png' },
        after: { bytes: 90, width: 10, height: 10, format: 'png', contentHash: 'f'.repeat(64) },
      }),
    ]);
    expect(png).toMatch(/class="zoom alpha"/);

    // A JPEG cannot hold transparency, so a checkerboard behind one would be
    // decoration that says something false.
    expect(render([entry()])).not.toMatch(/class="zoom alpha"/);
  });

  it('gives the after pane a mouse route even at a full overlay reveal', () => {
    const html = render([entry()]);

    expect(html).toMatch(/data-zoom-pane="before"/);
    expect(html).toMatch(/data-zoom-pane="after"/);
    // The clipped layer stops swallowing clicks meant for the pane underneath.
    expect(html).toMatch(/\.card\[data-view=overlay\] \.pane-before \{[^}]*pointer-events:none/);
  });
});

describe('openerFor', () => {
  it('picks the platform command, and never a shell string', () => {
    expect(openerFor('darwin')).toEqual({ command: 'open', args: [] });
    expect(openerFor('linux')).toEqual({ command: 'xdg-open', args: [] });
    // The empty title argument matters: without it `start` reads the path as the
    // window title and opens nothing.
    expect(openerFor('win32')).toEqual({ command: 'cmd', args: ['/c', 'start', ''] });
  });
});
