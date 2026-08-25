import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = new URL('./out/', import.meta.url).pathname;

// Campos que nunca devem aparecer em claro nas amostras salvas em disco.
const PII_FIELDS = new Set([
  'email',
  'telefone',
  'nascimento',
  'pacienteNome',
  'pacienteCPF',
  'prescritorConselho',
]);

function redigir(data) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (PII_FIELDS.has(key)) {
      out[key] = value ? '[REDIGIDO]' : value;
    } else if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.toDate !== 'function') {
      out[key] = redigir(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function redigirAmostra(doc) {
  return { id: doc.id, data: redigir(doc.data) };
}

function contarFlags(flags) {
  return Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v.length]));
}

function markdownFlags(flags) {
  const linhas = ['## Flags de qualidade', ''];
  for (const [nome, lista] of Object.entries(flags)) {
    linhas.push(`### ${nome} (${lista.length})`);
    if (lista.length === 0) {
      linhas.push('_nenhuma ocorrência_', '');
      continue;
    }
    linhas.push('```json');
    linhas.push(JSON.stringify(lista.slice(0, 20), null, 2));
    if (lista.length > 20) linhas.push(`... (+${lista.length - 20} não exibidas, ver JSON completo)`);
    linhas.push('```', '');
  }
  return linhas.join('\n');
}

export async function writeAuditReport({ counts, samples, flags, generatedAt }) {
  await mkdir(OUT_DIR, { recursive: true });

  const jsonPath = path.join(OUT_DIR, 'legacy-audit-report.json');
  const mdPath = path.join(OUT_DIR, 'legacy-audit-report.md');

  await writeFile(
    jsonPath,
    JSON.stringify({ generatedAt, counts, flagCounts: contarFlags(flags), flags, samples }, null, 2)
  );

  const md = [
    '# Auditoria do legado Firebase (farmhmmv)',
    '',
    `Gerado em: ${generatedAt}`,
    '',
    '## Contagens por coleção',
    '',
    '| Coleção | Documentos |',
    '| --- | ---: |',
    ...Object.entries(counts).map(([col, n]) => `| ${col} | ${n} |`),
    '',
    markdownFlags(flags),
  ].join('\n');

  await writeFile(mdPath, md);

  return { jsonPath, mdPath };
}
