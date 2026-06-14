import { expect } from 'chai';
import { analyzeDiagnosticKnowledge } from '../knowledge/diagnosticRouting';
import { queryGameKnowledge } from '../knowledge/gameKnowledge';
import { queryWorkflowHints } from '../knowledge/workflowHints';

describe('knowledge contract', () => {
  it('returns structured game knowledge without VS Code dependencies', () => {
    const result = queryGameKnowledge('stellaris');
    expect(result.status).to.equal('ready');
    expect(result.cards.length).to.be.greaterThan(1);
    expect(result.cards[0]).to.have.keys(['id', 'title', 'facts']);
  });

  it('routes localisation diagnostics to localisation tools', () => {
    const result = analyzeDiagnosticKnowledge({ message: 'Missing localisation key' });
    expect(result.category).to.equal('localisation');
    expect(result.suggestedTools).to.include('write_localisation');
  });

  it('exposes workflow hints as structured cards', () => {
    const result = queryWorkflowHints();
    expect(result.status).to.equal('ready');
    expect(result.hints.map(hint => hint.id)).to.include('diagnostic-fix');
  });
});
