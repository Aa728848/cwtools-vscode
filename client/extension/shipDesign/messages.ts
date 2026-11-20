import { ShipDesignEditError } from './designDocument';
import type { ShipDesignText } from './generator';

/**
 * User-facing copy for workbench errors. Pure modules throw stable `ShipDesignEditError` codes
 * with English detail; this maps each code to the display language so the Webview never shows
 * untranslated Host text in a Chinese UI. Unknown codes and plain errors keep their message.
 */
const ERROR_TEXT: Record<string, [string, string]> = {
    'design-not-found': ['The selected design no longer exists. Reload the workbench.', '所选设计已不存在，请重新加载工作台。'],
    'section-not-found': ['The selected section no longer exists. Reload the workbench.', '所选分段已不存在，请重新加载工作台。'],
    'slot-not-found': ['The target slot no longer exists.', '目标槽位已不存在。'],
    'component-not-found': ['The component no longer exists in the loaded definitions.', '已加载的定义中找不到该部件。'],
    'incompatible-drop': ['This component cannot be placed in that slot.', '该部件无法放入此槽位。'],
    'syntax-error': ['Fix the document braces before using visual write-back.', '请先修复文档中的括号错误，再使用可视化写回。'],
    'growth-stage-read-only': ['Loadouts with growth stages are read-only in the workbench.', '含成长阶段的配装在工作台中为只读。'],
    'ambiguous-field': ['The design repeats a field; edit the source to disambiguate it.', '设计中存在重复字段，请在源文件中消除歧义。'],
    'ambiguous-slot': ['Several components use the same slot; edit the source to disambiguate them.', '多个部件使用同一槽位，请在源文件中消除歧义。'],
    'overlapping-edits': ['The operation produced overlapping source edits.', '该操作产生了重叠的源码修改。'],
    'empty-name': ['A design name is required.', '必须填写设计名称。'],
    'duplicate-name': ['A design with this name already exists in the document.', '文档中已存在同名设计。'],
    'missing-name': ['Cannot duplicate a design without a name field.', '没有名称字段的设计无法复制。'],
    'field-not-editable': ['This field is not editable in the workbench.', '该字段无法在工作台中编辑。'],
    'boolean-required': ['This field requires a yes/no value.', '该字段只能是 yes 或 no。'],
    'host-only-operation': ['This operation must be validated by the workbench.', '该操作必须由工作台校验后执行。'],
    'version-conflict': ['The source changed outside the workbench. Your draft is preserved; discard it to adopt the external contents.', '源文件已在工作台外修改。草稿已保留；放弃草稿即可采用外部内容。'],
    'edit-rejected': ['VS Code rejected the source edit.', 'VS Code 拒绝了源码修改。'],
    'invalid-workspace-design': ['The design is outside the workspace global_ship_designs directories.', '该设计不在工作区的 global_ship_designs 目录中。'],
};

export function shipDesignErrorText(error: unknown, text: ShipDesignText): string {
    if (error instanceof ShipDesignEditError) {
        const entry = ERROR_TEXT[error.code];
        if (entry) return text(entry[0], entry[1]);
    }
    return error instanceof Error ? error.message : String(error);
}
