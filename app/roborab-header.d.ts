export function attachRoborabHeader(
  header: HTMLElement,
  status: HTMLElement,
  options?: {
    scrollSelector?: string;
    offsetHost?: HTMLElement;
    paused?: () => boolean;
    onGlass?: (glass: boolean) => void;
  },
): () => void;
