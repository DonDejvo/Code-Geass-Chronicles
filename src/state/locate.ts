import { createContext, useContext } from 'react';
export const LocateCtx = createContext<(eventId: string) => void>(() => {});
export const useLocate = () => useContext(LocateCtx);
