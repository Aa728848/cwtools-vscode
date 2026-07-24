import { expect } from 'chai';
import { formatMemDiagEntry, memDiagLanguageForLocale } from '../../extension/memDiagFormatter';

describe('MemDiag locale-aware formatter', () => {
	it('groups memory, diagnostics, and caches with bilingual labels', () => {
		const message = 'AnalyzePass cycleAllocMB=39819 strings=671297 ints=1000109 mem[heap=3366MB alloc=192310MB working=6164MB private=6282MB fragmented=517MB gc0=3163 gc1=275 gc2=13] diag[files=7191 fresh=0 pending=7191 stale=0 errors=310 warnings=72] caches[semantic=0 codeLens=0 inlay=0 locFiles=8 locKeys=156905 completionTTL=0 typeRefs=0 groupedTypeFiles=0 cacheWriteKeys=10]';
		const lines = formatMemDiagEntry({ category: 'Memory', message, timestamp: '10:40:23' }, '00:00:00', 'zh');

		expect(lines[0]).to.equal('[10:40:23] [内存] 分析周期');
		expect(lines.some(line => line.includes('本周期分配: 39819 MB [cycleAllocMB=39819]'))).to.equal(true);
		expect(lines.some(line => line.startsWith('  内存: '))).to.equal(true);
		expect(lines.some(line => line.startsWith('  诊断: '))).to.equal(true);
		expect(lines.some(line => line.startsWith('  缓存: '))).to.equal(true);
		expect(lines.every(line => !line.includes(' / '))).to.equal(true);
		expect(lines.at(-1)).to.equal('');
	});

	it('keeps a Windows path containing spaces on its own line', () => {
		const file = 'c:\\Users\\eddy\\Documents\\Paradox Interactive\\Stellaris\\mod\\mymod\\common\\scripted_modifiers\\test.txt';
		const message = `Hover file=${file} line=8 char=14 elapsed=32ms allocDeltaMB=60 cachedLocKeys=156905 caches[semantic=3 codeLens=2]`;
		const lines = formatMemDiagEntry({ category: 'Hover', message }, '10:40:23', 'en');

		expect(lines[0]).to.equal('[10:40:23] [Hover] Hover');
		expect(lines).to.include(`  File [file]: ${file}`);
		expect(lines.some(line => line.includes('Line: 8') && line.includes('Character: 14'))).to.equal(true);
		expect(lines.some(line => line.includes('Allocated by operation: 60 MB [allocDeltaMB=60]'))).to.equal(true);
		expect(lines.every(line => !line.includes('悬停'))).to.equal(true);
	});

	it('translates incremental and skipped status descriptions', () => {
		const incremental = formatMemDiagEntry({
			category: 'Localisation',
			message: 'LocErrors incremental keys/files affected=3 errors=1',
		}, '10:00:00', 'zh');
		const skipped = formatMemDiagEntry({
			category: 'Refresh',
			message: 'RefreshCaches skipped pending=true quiet=False',
		}, '10:00:01', 'en');

		expect(incremental[0]).to.include('增量影响的 key/文件');
		expect(incremental[0]).not.to.include('incrementally affected');
		expect(skipped[0]).to.include('skipped');
		expect(skipped.some(line => line.includes('Pending: true [pending=true]'))).to.equal(true);
		expect(skipped.some(line => line.includes('Quiet period reached: false [quiet=False]'))).to.equal(true);
	});

	it('removes injected line breaks while retaining unknown fields', () => {
		const lines = formatMemDiagEntry({
			category: 'Custom',
			message: 'CustomEvent\ncustomMetric=42',
			timestamp: '10:00:02\nspoofed',
		}, '00:00:00');

		expect(lines[0]).to.equal('[10:00:02 spoofed] [Custom] CustomEvent');
		expect(lines.some(line => line.includes('customMetric: 42'))).to.equal(true);
		expect(lines.filter(line => line.includes('CustomEvent')).length).to.equal(1);
	});

	it('selects Chinese only for VS Code Chinese locales', () => {
		expect(memDiagLanguageForLocale('zh-cn')).to.equal('zh');
		expect(memDiagLanguageForLocale('ZH-TW')).to.equal('zh');
		expect(memDiagLanguageForLocale('zh')).to.equal('zh');
		expect(memDiagLanguageForLocale('en-us')).to.equal('en');
		expect(memDiagLanguageForLocale('de')).to.equal('en');
	});
});
