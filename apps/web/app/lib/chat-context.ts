import { createContext } from "react";

// Context for child routes to open the conversations sidebar on mobile
export const ChatSidebarContext = createContext<{
  onSidebarOpen: () => void;
} | null>(null);
