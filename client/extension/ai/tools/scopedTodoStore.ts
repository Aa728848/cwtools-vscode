import type { TodoItem } from '../types';

const ROOT_SCOPE = 'root';

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
    return todos.map(todo => ({ ...todo }));
}

/** Keeps root and child-Agent task lists independent while sharing one tool executor. */
export class ScopedTodoStore {
    private readonly todosByScope = new Map<string, TodoItem[]>();

    get(agentId?: string): TodoItem[] {
        return cloneTodos(this.todosByScope.get(agentId || ROOT_SCOPE) ?? []);
    }

    set(todos: readonly TodoItem[], agentId?: string): TodoItem[] {
        const snapshot = cloneTodos(todos);
        this.todosByScope.set(agentId || ROOT_SCOPE, snapshot);
        return cloneTodos(snapshot);
    }

    clear(agentId?: string): void {
        this.todosByScope.delete(agentId || ROOT_SCOPE);
    }
}
