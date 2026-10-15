import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';

// Global store for image URL cache and directory handle
// This allows components inside Canvas (separate React tree) to access the data
let globalDirHandle: FileSystemDirectoryHandle | null = null;
let globalImageUrls: Record<string, string> = {};
let globalVersion = 0;
const imageUrlListeners: Set<() => void> = new Set();

export function getGlobalDirHandle() {
  return globalDirHandle;
}

export function getGlobalVersion() {
  return globalVersion;
}

export function clearImageCache() {
  // Revoke existing blob URLs to prevent memory leaks
  Object.values(globalImageUrls).forEach(url => {
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  });
  globalImageUrls = {};
  globalVersion++;
  imageUrlListeners.forEach(listener => listener());
}

export async function resolveImageUrl(imagePath: string): Promise<string> {
  // If it's already a URL, return as-is
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) {
    return imagePath;
  }

  // Check cache first
  if (globalImageUrls[imagePath]) {
    return globalImageUrls[imagePath];
  }

  // If no directory handle, return the path as-is (fallback to public folder)
  if (!globalDirHandle) {
    return imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
  }

  try {
    // Navigate to file - handle nested paths
    const pathParts = imagePath.split('/').filter(Boolean);
    let currentHandle: FileSystemDirectoryHandle | FileSystemFileHandle = globalDirHandle;
    
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];
      if (i === pathParts.length - 1) {
        // Last part is the file
        currentHandle = await (currentHandle as FileSystemDirectoryHandle).getFileHandle(part);
      } else {
        // Navigate into directory
        currentHandle = await (currentHandle as FileSystemDirectoryHandle).getDirectoryHandle(part);
      }
    }

    const file = await (currentHandle as FileSystemFileHandle).getFile();
    const url = URL.createObjectURL(file);
    
    globalImageUrls[imagePath] = url;
    imageUrlListeners.forEach(listener => listener());
    return url;
  } catch (err) {
    console.warn(`Failed to load image from data folder: ${imagePath}`, err);
    return imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
  }
}

interface DataFolderContextType {
  dirHandle: FileSystemDirectoryHandle | null;
  setDirHandle: (handle: FileSystemDirectoryHandle | null) => void;
  getImageUrl: (imagePath: string) => Promise<string>;
  imageUrls: Record<string, string>;
  version: number;
}

const DataFolderContext = createContext<DataFolderContextType | null>(null);

export function DataFolderProvider({ children }: { children: ReactNode }) {
  const [dirHandle, setDirHandleState] = useState<FileSystemDirectoryHandle | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);

  // Keep global state in sync with React state
  const setDirHandle = useCallback((handle: FileSystemDirectoryHandle | null) => {
    // Clear cache when folder changes
    clearImageCache();
    globalDirHandle = handle;
    setDirHandleState(handle);
  }, []);

  // Subscribe to global image URL changes
  useEffect(() => {
    const listener = () => {
      setImageUrls({ ...globalImageUrls });
      setVersion(globalVersion);
    };
    imageUrlListeners.add(listener);
    return () => {
      imageUrlListeners.delete(listener);
    };
  }, []);

  const getImageUrl = useCallback(async (imagePath: string): Promise<string> => {
    return resolveImageUrl(imagePath);
  }, []);

  return (
    <DataFolderContext.Provider value={{ dirHandle, setDirHandle, getImageUrl, imageUrls, version }}>
      {children}
    </DataFolderContext.Provider>
  );
}

export function useDataFolder() {
  const context = useContext(DataFolderContext);
  if (!context) {
    throw new Error('useDataFolder must be used within a DataFolderProvider');
  }
  return context;
}
