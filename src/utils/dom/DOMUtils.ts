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
