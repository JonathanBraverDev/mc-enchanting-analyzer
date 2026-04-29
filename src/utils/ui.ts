/**
 * Utility for string formatting.
 */
export class StringUtils {
    /**
     * Converts a snake_case slug to Title Case.
     */
    static toTitleCase(slug: string): string {
        return slug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
}

/**
 * Utility for UI-specific formatting.
 */
export class UIUtils {
    /**
     * Formats a probability as a percentage string.
     */
    static formatPercent(prob: number): string {
        return (prob * 100).toFixed(1) + "%";
    }
}

/**
 * Utility for asynchronous operations.
 */
export class AsyncUtils {
    /**
     * Yields execution to the macro-task queue.
     */
    static yield(): Promise<void> {
        return new Promise(r => setTimeout(r, 0));
    }
}

/**
 * Utility for DOM manipulation.
 */
export class DOMUtils {
    /**
     * Creates and adds an option element to a select element.
     */
    static addOption(select: HTMLSelectElement, value: string, text: string, selected: boolean = false): void {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        if (selected) o.selected = true;
        select.appendChild(o);
    }
}
