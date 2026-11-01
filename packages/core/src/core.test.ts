import { describe, expect, it } from 'vitest';
import { normalizeTranscriptLine, projectFromCwd, projectRoot, redact, regionForTool } from './index.ts';

describe('projectFromCwd', () => {
  it('rolls sub-folders up into their project', () => {
    expect(projectFromCwd('C:\\Users\\vikas\\OneDrive\\Desktop\\Friday')).toBe('Friday');
    expect(projectFromCwd('C:\\Users\\vikas\\OneDrive\\Desktop\\StockBot\\data\\work\\XOM')).toBe('StockBot');
    expect(projectFromCwd('C:\\Users\\vikas\\PycharmProjects\\xosippy_scraper\\data\\parsed\\literotica')).toBe('xosippy_scraper');
    expect(projectFromCwd('C:\\Users\\vikas\\Desktop\\interview')).toBe('interview');
  });
  it('handles odd locations', () => {
    expect(projectFromCwd('C:\\Users\\vikas')).toBe('Home folder');
    expect(projectFromCwd('D:\\New folder\\Videos')).toBe('Videos');
    expect(projectFromCwd('D:\\New folder')).toBe('Unsorted files');
    expect(projectFromCwd('D:\\neha_projects')).toBe('neha_projects');
    expect(projectFromCwd('C:\\Users\\vikas\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\b')).toBe('Claude scratch');
    expect(projectFromCwd('C:\\WINDOWS\\system32')).toBe('System');
    expect(projectFromCwd(null)).toBeNull();
  });
});

describe('projectRoot', () => {
  it('returns the project folder, not a sub-folder', () => {
    expect(projectRoot('C:\\Users\\vikas\\OneDrive\\Desktop\\StockBot\\data\\work\\XOM')).toBe('C:\\Users\\vikas\\OneDrive\\Desktop\\StockBot');
    expect(projectRoot('C:\\Users\\vikas\\PycharmProjects\\xosippy_scraper\\data')).toBe('C:\\Users\\vikas\\PycharmProjects\\xosippy_scraper');
    expect(projectRoot('D:\\New folder\\Videos')).toBe('D:\\New folder\\Videos');
    expect(projectRoot('C:\\WINDOWS\\system32')).toBeNull();
  });
});

describe('redact', () => {
  it('masks common secrets', () => {
    const s = 'key sk-ant-abcdefghijklmnopqrstuvwx and API_KEY=supersecret123 and postgres://u:hunter2pw@host/db';
    const r = redact(s);
    expect(r).not.toContain('abcdefghijklmnop');
    expect(r).not.toContain('supersecret123');
    expect(r).not.toContain('hunter2pw');
  });
  it('leaves normal text alone', () => {
    expect(redact('read the file src/index.ts')).toBe('read the file src/index.ts');
  });
});

describe('regionForTool', () => {
  it('maps tools to regions', () => {
    expect(regionForTool('Read')).toBe('occipital');
    expect(regionForTool('Edit', { file_path: 'a.ts' })).toBe('motor');
    expect(regionForTool('Bash', { command: 'npm run test' })).toBe('cerebellum');
    expect(regionForTool('Bash', { command: 'ls' })).toBe('motor');
    expect(regionForTool('WebSearch')).toBe('parietal');
    expect(regionForTool('Read', {}, true)).toBe('amygdala');
    expect(regionForTool('mcp__x__y')).toBe('parietal');
  });
});

describe('normalizeTranscriptLine', () => {
  const base = { uuid: 'u1', sessionId: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: 'C:\\Users\\u\\Desktop\\Proj\\src' };
  it('extracts a prompt and ignores system reminders', () => {
    const ev = normalizeTranscriptLine({ ...base, type: 'user', message: { role: 'user', content: 'hello' } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'prompt', project: 'Proj', region: 'temporal' });
    expect(normalizeTranscriptLine({ ...base, type: 'user', message: { content: '<system-reminder>x</system-reminder>' } })).toHaveLength(0);
  });
  it('splits assistant blocks into events', () => {
    const ev = normalizeTranscriptLine({
      ...base, type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read', input: { file_path: 'x.ts' } }] },
    });
    expect(ev.map((e) => e.kind)).toEqual(['reply', 'tool_use']);
    expect(ev[1]).toMatchObject({ region: 'occipital', tool: 'Read', text: 'Read: x.ts' });
    expect(new Set(ev.map((e) => e.key)).size).toBe(2);
  });
  it('flags tool errors as amygdala', () => {
    const ev = normalizeTranscriptLine({
      ...base, type: 'user', message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] },
    });
    expect(ev[0]).toMatchObject({ region: 'amygdala', isError: true });
  });
});
