import { DocumentsShell } from '@/components/documents/DocumentsShell';

/**
 * Раздел «Документы»: общий каркас для каталога (/documents) и открытого документа (/documents/[id]).
 * Каталог остаётся на месте, когда справа открывается документ.
 */
export default function DocumentsLayout({ children }: { children: React.ReactNode }) {
  return <DocumentsShell>{children}</DocumentsShell>;
}
