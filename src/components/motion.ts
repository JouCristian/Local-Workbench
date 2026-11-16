import { useSyncExternalStore } from 'react';

// Subscribe to changes, rather than reading the preference only when a component mounts.
const reducedQuery = '(prefers-reduced-motion: reduce)';
function subscribe(listener: () => void) {
  const media = matchMedia(reducedQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
const snapshot = () => matchMedia(reducedQuery).matches;
export const useMotionPreference = () => useSyncExternalStore(subscribe, snapshot, () => false);

// SWUST-OC easing, adapted to short desktop interactions.
export const appleEase = [0.22, 1, 0.36, 1] as const;
export const appleEaseCss = 'cubic-bezier(.22,1,.36,1)';
export const contentEntrance = {
  hidden: { opacity: 0.65 },
  visible: { opacity: 1, transition: { duration: 0.56, ease: appleEase } },
};
export const staticEntrance = {
  hidden: { opacity: 1 },
  visible: { opacity: 1, transition: { duration: 0 } },
};
export function useContentEntrance() {
  return useMotionPreference() ? staticEntrance : contentEntrance;
}
