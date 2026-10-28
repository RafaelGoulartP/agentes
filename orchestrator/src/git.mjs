// Exclui apenas refs internas da issue; nunca branches entregues.
export function deleteRefs(git, issue) {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('issue inválida para faxina');
  const prefix = `refs/lab/issue-${issue}/`;
  const refs = git(['for-each-ref', '--format=%(refname)', prefix]).stdout.split(/\r?\n/).filter((ref) => ref.startsWith(prefix));
  for (const ref of refs) git(['update-ref', '-d', ref]);
  return refs.length;
}
