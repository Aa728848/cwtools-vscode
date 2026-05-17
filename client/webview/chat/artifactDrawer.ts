import { svgIconNoMargin } from '../svgIcons';
import { escapeHtml } from './formatters';
import {
    artifactPreviewPayload,
    fileBaseName,
    filterArtifacts,
    formatArtifactFileStats,
    getDiffArtifactFiles,
    type ArtifactFilter,
    type ArtifactRecord,
} from './artifacts';
import type { ChatI18nText } from './i18n';

export interface ArtifactDrawerElements {
    list: HTMLElement | null;
    count: HTMLElement | null;
    toggle: HTMLElement | null;
    filterButtons: ArrayLike<HTMLElement>;
}

export interface ArtifactDrawerCallbacks {
    openPlanFile: (filePath: string) => void;
    openArtifact: (artifactId: string, file?: string) => void;
}

const ARTIFACT_ICON: Record<ArtifactRecord['kind'], string> = {
    plan: 'clipboard',
    blueprint: 'layers',
    walkthrough: 'flag',
    diff: 'edit',
    diagnostics: 'stethoscope',
    validation: 'check',
    media: 'sparkles',
    blackboard: 'bookmark',
};

export function renderArtifactDrawer(
    elements: ArtifactDrawerElements,
    artifacts: ArtifactRecord[],
    artifactFilter: ArtifactFilter,
    i18n: ChatI18nText,
    callbacks: ArtifactDrawerCallbacks,
): void {
    const { list, count, toggle } = elements;
    if (!list || !count) return;

    for (const btn of Array.from(elements.filterButtons)) {
        btn.classList.toggle('active', (btn.dataset.artifactFilter || 'all') === artifactFilter);
    }
    count.textContent = String(artifacts.length);
    toggle?.classList.toggle('has-artifacts', artifacts.length > 0);

    if (artifacts.length === 0) {
        list.innerHTML = renderArtifactEmpty(i18n.artifact.emptyTitle, i18n.artifact.emptySubtitle);
        return;
    }

    const visibleArtifacts = filterArtifacts(artifacts, artifactFilter);
    if (visibleArtifacts.length === 0) {
        list.innerHTML = renderArtifactEmpty(i18n.artifact.emptyFilterTitle, i18n.artifact.emptyFilterSubtitle);
        return;
    }

    list.innerHTML = '';
    for (const artifact of visibleArtifacts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `artifact-row artifact-${artifact.kind} artifact-${artifact.status || 'done'}`;
        row.innerHTML = renderArtifactRowHtml(artifact, i18n);
        if (artifact.kind === 'diff' || artifact.action === 'openDiff') {
            row.addEventListener('click', () => toggleDiffArtifactDetails(row, artifact, callbacks));
        } else if (artifact.filePath) {
            row.addEventListener('click', () => callbacks.openPlanFile(artifact.filePath!));
        } else {
            row.addEventListener('click', () => toggleArtifactPreview(row, artifact));
        }
        list.appendChild(row);
    }
}

export function renderArtifactRowHtml(artifact: ArtifactRecord, i18n: ChatI18nText): string {
    const iconName = ARTIFACT_ICON[artifact.kind] || 'file';
    const status = artifact.status || 'done';
    const statusLabel = i18n.artifact.status[status] || status;
    return `
        <span class="artifact-icon">${svgIconNoMargin(iconName as any)}</span>
        <span class="artifact-main">
            <span class="artifact-title">${escapeHtml(artifact.title)}</span>
            <span class="artifact-summary">${escapeHtml(artifact.summary || artifact.relPath || artifact.kind)}</span>
        </span>
        <span class="artifact-status">${escapeHtml(statusLabel)}</span>
    `;
}

export function renderArtifactEmpty(title: string, subtitle: string): string {
    return `
        <div class="artifact-empty">
            <div class="artifact-empty-title">${escapeHtml(title)}</div>
            <div class="artifact-empty-subtitle">${escapeHtml(subtitle)}</div>
        </div>
    `;
}

export function toggleArtifactPreview(row: HTMLElement, artifact: ArtifactRecord): void {
    const next = row.nextElementSibling as HTMLElement | null;
    if (next?.classList.contains('artifact-preview')) {
        next.remove();
        return;
    }
    const preview = document.createElement('pre');
    preview.className = 'artifact-preview';
    preview.textContent = JSON.stringify(artifactPreviewPayload(artifact), null, 2).slice(0, 6000);
    row.insertAdjacentElement('afterend', preview);
}

export function toggleDiffArtifactDetails(
    row: HTMLElement,
    artifact: ArtifactRecord,
    callbacks: Pick<ArtifactDrawerCallbacks, 'openArtifact'>,
): void {
    const next = row.nextElementSibling as HTMLElement | null;
    if (next?.classList.contains('artifact-file-list')) {
        next.remove();
        row.classList.remove('expanded');
        return;
    }

    document.querySelectorAll('.artifact-file-list').forEach(el => el.remove());
    document.querySelectorAll('.artifact-row.expanded').forEach(el => el.classList.remove('expanded'));

    const files = getDiffArtifactFiles(artifact);
    const details = document.createElement('div');
    details.className = 'artifact-file-list';
    if (files.length === 0) {
        details.innerHTML = '<div class="artifact-file-empty">No file changes recorded.</div>';
    } else {
        const header = document.createElement('div');
        header.className = 'artifact-file-list-header';
        header.innerHTML = `<span>${files.length} file${files.length === 1 ? '' : 's'}</span>`;
        const openAll = document.createElement('button');
        openAll.type = 'button';
        openAll.className = 'artifact-open-all';
        openAll.textContent = 'Open all';
        openAll.addEventListener('click', event => {
            event.stopPropagation();
            callbacks.openArtifact(artifact.id);
        });
        header.appendChild(openAll);
        details.appendChild(header);

        for (const file of files) {
            const fileRow = document.createElement('button');
            fileRow.type = 'button';
            fileRow.className = 'artifact-file-row';
            const stats = formatArtifactFileStats(file);
            fileRow.innerHTML = `
                <span class="artifact-file-name" title="${escapeHtml(file.file)}">${escapeHtml(fileBaseName(file.file))}</span>
                <span class="artifact-file-path">${escapeHtml(file.file)}</span>
                ${stats ? `<span class="artifact-file-stats">${escapeHtml(stats)}</span>` : ''}
            `;
            fileRow.addEventListener('click', event => {
                event.stopPropagation();
                callbacks.openArtifact(artifact.id, file.file);
            });
            details.appendChild(fileRow);
        }
    }
    row.insertAdjacentElement('afterend', details);
    row.classList.add('expanded');
}
