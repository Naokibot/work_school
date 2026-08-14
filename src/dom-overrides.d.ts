export {}

declare global {
  interface Document {
    querySelector<E extends Element = Element>(selectors: '#app'): E
    querySelector<K extends keyof HTMLElementTagNameMap>(selectors: K): HTMLElementTagNameMap[K] | null
    querySelector<K extends keyof SVGElementTagNameMap>(selectors: K): SVGElementTagNameMap[K] | null
    querySelector<K extends keyof MathMLElementTagNameMap>(selectors: K): MathMLElementTagNameMap[K] | null
    querySelector<E extends Element = Element>(selectors: string): E | null
  }

  interface HTMLInputElement {
    addEventListener(
      type: 'change',
      listener: (this: HTMLInputElement, event: Event & { readonly currentTarget: HTMLInputElement }) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void
  }
}
