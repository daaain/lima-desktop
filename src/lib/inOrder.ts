// Requests that replace one another (the same history for a newer window, the same list after a
// stall began) can be answered in any order, and an older answer landing late would put back what
// a newer one had replaced: the range picker saying 7 d over charts of 24 h, say.

/**
 * One run of requests for the same thing: pass each one's promise through it as it's made. Its
 * answer, or failure, settles as usual unless a later request's has already; then it never
 * settles, so nothing it would have set is touched.
 *
 * Not only the latest request's answer is kept, as an effect's cleanup would have it: a live range
 * asks again at every measurement, and an answer that took longer than that would never be shown.
 * An older answer that lands first is the newest there is until the next one does.
 */
export function inOrder() {
  let asked = 0;
  let answered = 0;
  return <T>(request: Promise<T>): Promise<T> => {
    const n = ++asked;
    const current = () => n > answered && ((answered = n), true);
    return new Promise<T>((resolve, reject) => {
      request.then(
        (v) => current() && resolve(v),
        (e) => current() && reject(e),
      );
    });
  };
}
