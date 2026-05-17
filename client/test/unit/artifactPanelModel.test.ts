import { expect } from 'chai';
import { getDiffArtifactFilesForWebview } from '../../webview/artifactPanelModel';

describe('artifactPanelModel', () => {
    it('extracts diff files from artifact data', () => {
        const files = getDiffArtifactFilesForWebview({
            data: {
                files: [
                    { file: 'common/foo.txt', status: 'modified', additions: 2, deletions: 1 },
                    { file: 'events/bar.txt', diffPreview: '+ file added' },
                ],
            },
        });

        expect(files).to.have.lengthOf(2);
        expect(files[0]!.file).to.equal('common/foo.txt');
        expect(files[0]!.status).to.equal('modified');
        expect(files[1]!.diffPreview).to.equal('+ file added');
    });
});
