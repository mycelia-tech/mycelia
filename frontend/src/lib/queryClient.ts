import { QueryClient } from "@tanstack/react-query";

/** Shared so changing authentication can discard all cached personal data. */
export const queryClient = new QueryClient();
