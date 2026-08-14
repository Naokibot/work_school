export {}

declare global {
  interface Document {
    querySelector<E extends Element = Element>(selectors: '#app'): E
  }

  interface HTMLInputElement {
    addEventListener(
      type: 'change',
      listener: (this: HTMLInputElement, event: Event & { readonly currentTarget: HTMLInputElement }) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void
  }
}
