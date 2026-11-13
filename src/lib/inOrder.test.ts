import { describe, expect, it } from 'vitest';
import { inOrder } from './inOrder';

/** A promise and the means to settle it, whenever the test likes. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

// Long enough for every handler already due to have run.
const settled = () => new Promise((r) => setTimeout(r));

/** Passes `count` requests through one sequence, and notes what each one's handlers were given. */
function asked<T>(count: number) {
  const order = inOrder();
  const requests = Array.from({ length: count }, () => deferred<T>());
  const seen: string[] = [];
  requests.forEach((r, i) => order(r.promise).then((v) => seen.push(`${i}: ${v}`), (e) => seen.push(`${i} failed: ${e}`)));
  return { requests, seen };
}

describe('answers in the order asked', () => {
  it('drops an answer that comes after a later request has been answered', async () => {
    const { requests, seen } = asked<string>(2);
    requests[1].resolve('7d');
    requests[0].resolve('24h');
    await settled();
    expect(seen).toEqual(['1: 7d']);
  });
  it('keeps every answer that comes in the order asked', async () => {
    // Not only the latest: one that lands before a later request's answer is the newest there is.
    const { requests, seen } = asked<string>(2);
    requests[0].resolve('24h');
    await settled();
    requests[1].resolve('7d');
    await settled();
    expect(seen).toEqual(['0: 24h', '1: 7d']);
  });
  it('drops a failure behind a later answer too', async () => {
    const { requests, seen } = asked<string>(2);
    requests[1].resolve('7d');
    requests[0].reject('gone');
    await settled();
    expect(seen).toEqual(['1: 7d']);
  });
  it('counts a failure as an answer: an older success after it is dropped', async () => {
    const { requests, seen } = asked<string>(2);
    requests[1].reject('gone');
    requests[0].resolve('24h');
    await settled();
    expect(seen).toEqual(['1 failed: gone']);
  });
  it('drops all those overtaken, however many', async () => {
    const { requests, seen } = asked<number>(4);
    requests[2].resolve(2);
    requests[0].resolve(0);
    requests[3].resolve(3);
    requests[1].resolve(1);
    await settled();
    expect(seen).toEqual(['2: 2', '3: 3']);
  });
  it('keeps one sequence apart from another', async () => {
    const [a, b] = [inOrder(), inOrder()];
    const [first, second] = [deferred<string>(), deferred<string>()];
    const seen: string[] = [];
    a(first.promise).then((v) => seen.push(v));
    b(second.promise).then((v) => seen.push(v));
    second.resolve('b');
    first.resolve('a');
    await settled();
    expect(seen).toEqual(['b', 'a']);
  });
});
