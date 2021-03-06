/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {expect, use} from 'chai';
import chaiAsPromised from 'chai-as-promised';
import {ClientRequest, IncomingMessage} from 'http';
import https from 'https';
import {toArray} from 'rxjs/operators';
import {SinonStub, stub} from 'sinon';
import {PassThrough, Writable} from 'stream';

import {load} from '../../src/triples/reader';
import {Triple} from '../../src/triples/triple';
import {SchemaString, UrlNode} from '../../src/triples/types';
import {flush} from '../helpers/async';

use(chaiAsPromised);

describe('load', () => {
  let get: SinonStub<
      Parameters<typeof https['get']>, ReturnType<typeof https['get']>>;

  beforeEach(() => {
    get = stub(https, 'get');
  });
  afterEach(() => {
    get.restore();
  });

  it('is lazy', () => {
    load('https://schema.org');
    expect(get.called).to.be.false;
  });

  it('total fail', async () => {
    const triples$ = load('https://schema.org/');

    const firstReturn = passThrough();
    get.onFirstCall().returns(firstReturn);
    firstReturn.destroy(new Error('Bad!!!'));

    await expect(triples$.toPromise()).to.eventually.rejectedWith('Bad!!!');

    expect(get.calledOnce).to.be.true;
  });

  describe('with one or more message', () => {
    let triples: Promise<Triple[]>;
    let fakeResponse: FakeResponseFunc;

    beforeEach(async () => {
      const triples$ = load('https://schema.org/');
      get.onFirstCall().callsFake((_, cb) => {
        // Unfortunately, we use another overload that doesn't appear here.
        const callback = cb as {} as (inc: IncomingMessage) => void;
        fakeResponse = makeFakeResponse(callback);

        return passThrough();
      });

      // toPromise makes Observables un-lazy, so we can just go ahead.
      triples = triples$.pipe(toArray()).toPromise();

      await flush();
    });

    it('METATEST', () => {
      // Make sure our test machinery works. If the METATEST fails, then
      // the test code itself broke.
      expect(get.called).to.be.true;
      expect(triples).not.to.be.undefined;
      expect(fakeResponse).to.be.a('function');
    });

    it('First response fails at status', async () => {
      fakeResponse(500, 'So Sad!');

      await expect(triples).to.eventually.rejectedWith('So Sad!');
    });

    it('First response fails at error', async () => {
      const control = fakeResponse(200, 'Ok');
      control.error('So BAD!');

      await expect(triples).to.eventually.rejectedWith('So BAD!');
    });

    it('Immediate success (empty)', async () => {
      const control = fakeResponse(200, 'Ok');
      control.end();

      await expect(triples).to.eventually.deep.equal([]);
    });

    it('Oneshot', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> "math" .\n`);
      control.end();

      await expect(triples).to.eventually.deep.equal([{
        Subject: UrlNode.Parse('https://schema.org/Person'),
        Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
        Object: SchemaString.Parse('"math"')!,
      }]);
    });

    it('Multiple (clean broken)', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> "math" .\n`);
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> "science" .\n`);
      control.end();

      await expect(triples).to.eventually.deep.equal([
        {
          Subject: UrlNode.Parse('https://schema.org/Person'),
          Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
          Object: SchemaString.Parse('"math"')!,
        },
        {
          Subject: UrlNode.Parse('https://schema.org/Person'),
          Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
          Object: SchemaString.Parse('"science"')!,
        }
      ]);
    });

    it('Multiple (skip test comment)', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> "math" .\n`);
      control.data(
          `<http://meta.schema.org/> <http://www.w3.org/2000/01/rdf-schema#comment> "A test comment." .\n`);
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> "science" .\n`);
      control.end();

      await expect(triples).to.eventually.deep.equal([
        {
          Subject: UrlNode.Parse('https://schema.org/Person'),
          Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
          Object: SchemaString.Parse('"math"')!,
        },
        {
          Subject: UrlNode.Parse('https://schema.org/Person'),
          Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
          Object: SchemaString.Parse('"science"')!,
        }
      ]);
    });

    it('Multiple (throws from bad URL: Subject)', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> "math" .\n`);
      control.data(
          `<http://schema.org/> <http://www.w3.org/2000/01/rdf-schema#comment> "A test comment." .\n`);
      control.end();

      await expect(triples).to.eventually.rejectedWith(
          'ParseError: Error: Unexpected URL');
    });

    it('Multiple (throws from bad URL: Predicate)', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> "math" .\n`);
      control.data(
          `<http://schema.org/A> <https://schema.org> "A test comment." .\n`);
      control.end();

      await expect(triples).to.eventually.rejectedWith(
          'ParseError: Error: Unexpected URL');
    });

    it('Multiple (throws from bad URL: Object)', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(
          `<https://schema.org/Person> <https://schema.org/knowsAbout> <https://schema.org/> .\n`);
      control.data(
          `<http://schema.org/A> <http://www.w3.org/2000/01/rdf-schema#comment> "A test comment." .\n`);
      control.end();

      await expect(triples).to.eventually.rejectedWith(
          'ParseError: Error: Unexpected URL');
    });

    it('Multiple (dirty broken)', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(`<https://schema.org/Person> <https://sc`);
      control.data(
          `hema.org/knowsAbout> "math" .\n<https://schema.org/Person> <https://schema.org/knowsAbout> "science" .\n`);
      control.end();

      await expect(triples).to.eventually.deep.equal([
        {
          Subject: UrlNode.Parse('https://schema.org/Person'),
          Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
          Object: SchemaString.Parse('"math"')!,
        },
        {
          Subject: UrlNode.Parse('https://schema.org/Person'),
          Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
          Object: SchemaString.Parse('"science"')!,
        }
      ]);
    });

    it('Skips local files', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(`<https://schema.org/Person> <https://sc`);
      control.data(
          `hema.org/knowsAbout> "math" .\n<file:///usr/Person> <https://schema.org/knowsAbout> "science" .\n`);
      control.end();

      await expect(triples).to.eventually.deep.equal([{
        Subject: UrlNode.Parse('https://schema.org/Person'),
        Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
        Object: SchemaString.Parse('"math"')!,
      }]);
    });

    it('Skips schema layer attributions', async () => {
      const control = fakeResponse(200, 'Ok');
      control.data(`<https://schema.org/knowsAbout> <https://sc`);
      control.data(
          `hema.org/domainIncludes> <https://schema.org/Thing> .\n<https://schema.`);
      control.data(
          `org/knowsAbout> <http://schema.org/isPartOf> <http://pending.schema.org> .\n`);
      control.end();

      await expect(triples).to.eventually.deep.equal([{
        Subject: UrlNode.Parse('https://schema.org/knowsAbout'),
        Predicate: UrlNode.Parse('https://schema.org/domainIncludes'),
        Object: UrlNode.Parse('https://schema.org/Thing'),
      }]);
    });

    describe('.nt syntax errors', () => {
      it('partially missing', async () => {
        const control = fakeResponse(200, 'Ok');
        control.data(`<https://schema.org/knowsAbout> <https://sc`);
        control.end();
        await expect(triples).to.eventually.rejectedWith('Unexpected');
      });

      it('only two datums', async () => {
        const control = fakeResponse(200, 'Ok');
        control.data(`<https://schema.org/knowsAbout> <https://sc> .`);
        control.end();
        await expect(triples).to.eventually.rejectedWith('Unexpected');
      });

      it('missing dot', async () => {
        const control = fakeResponse(200, 'Ok');
        control.data(
            `<https://schema.org/knowsAbout> <https://scema.org/domainIncludes> "a"`);
        control.end();
        await expect(triples).to.eventually.rejectedWith('Unexpected');
      });

      it('Non-IRI Subject', async () => {
        const control = fakeResponse(200, 'Ok');
        control.data(`"knowsAbout" <https://scema.org/domainIncludes> "a" .`);
        control.end();
        await expect(triples).to.eventually.rejectedWith('Unexpected');
      });

      it('Non-IRI Predicate', async () => {
        const control = fakeResponse(200, 'Ok');
        control.data(`<https://schema.org/knowsAbout> "domainIncludes" "a"`);
        control.end();
        await expect(triples).to.eventually.rejectedWith('Unexpected');
      });

      it('Invalid object', async () => {
        const control = fakeResponse(200, 'Ok');
        control.data(`<https://schema.org/a> <https://schema.org/b> 'c`);
        control.end();
        await expect(triples).to.eventually.rejectedWith('Unexpected');
      });

      it('Domain only', async () => {
        const control = fakeResponse(200, 'Ok');
        control.data(`<https://schema.org/> <https://schema.org/b> "c"`);
        control.end();
        await expect(triples).to.eventually.rejectedWith('Unexpected');
      });
    });

    describe('redirects', () => {
      let fakeResponse2: FakeResponseFunc;

      beforeEach(async () => {
        get.onSecondCall().callsFake((_, cb) => {
          // Unfortunately, we use another overload that doesn't appear here.
          const callback = cb as {} as (inc: IncomingMessage) => void;
          fakeResponse2 = makeFakeResponse(callback);

          return passThrough();
        });

        fakeResponse(
            302, 'Redirect',
            {'location': 'https://schema.org/6.0/all-layers.nt'});
        await flush();
      });

      it('METATEST', () => {
        expect(fakeResponse2).to.be.a('function');
      });

      it('Post Redirect response fails at status', async () => {
        fakeResponse2(500, 'So Sad!');

        await expect(triples).to.eventually.rejectedWith('So Sad!');
      });

      it('Post Redirect response fails at error', async () => {
        const control = fakeResponse2(200, 'Ok');
        control.error('So BAD!');

        await expect(triples).to.eventually.rejectedWith('So BAD!');
      });

      it('Post Redirect (empty)', async () => {
        const control = fakeResponse2(200, 'Ok');
        control.end();

        await expect(triples).to.eventually.deep.equal([]);
      });

      it('Post Redirect Oneshot', async () => {
        const control = fakeResponse2(200, 'Ok');
        control.data(
            `<https://schema.org/Person> <https://schema.org/knowsAbout> "math" .\n`);
        control.end();

        await expect(triples).to.eventually.deep.equal([{
          Subject: UrlNode.Parse('https://schema.org/Person'),
          Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
          Object: SchemaString.Parse('"math"')!,
        }]);
      });

      it('Post Redirect Multiple (clean broken)', async () => {
        const control = fakeResponse2(200, 'Ok');
        control.data(
            `<https://schema.org/Person> <https://schema.org/knowsAbout> "math" .\n`);
        control.data(
            `<https://schema.org/Person> <https://schema.org/knowsAbout> "science" .\n`);
        control.end();

        await expect(triples).to.eventually.deep.equal([
          {
            Subject: UrlNode.Parse('https://schema.org/Person'),
            Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
            Object: SchemaString.Parse('"math"')!,
          },
          {
            Subject: UrlNode.Parse('https://schema.org/Person'),
            Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
            Object: SchemaString.Parse('"science"')!,
          }
        ]);
      });

      it('Post Redirect Multiple (dirty broken)', async () => {
        const control = fakeResponse2(200, 'Ok');
        control.data(`<https://schema.org/Person> <https://sc`);
        control.data(
            `hema.org/knowsAbout> "math" .\n<https://schema.org/Person> <https://schema.org/knowsAbout> "science" .\n`);
        control.end();

        await expect(triples).to.eventually.deep.equal([
          {
            Subject: UrlNode.Parse('https://schema.org/Person'),
            Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
            Object: SchemaString.Parse('"math"')!,
          },
          {
            Subject: UrlNode.Parse('https://schema.org/Person'),
            Predicate: UrlNode.Parse('https://schema.org/knowsAbout'),
            Object: SchemaString.Parse('"science"')!,
          }
        ]);
      });
    });
  });
});

function passThrough(): ClientRequest {
  return new PassThrough() as Writable as ClientRequest;
}

interface Control {
  data(s: string): void;
  end(): void;
  error(s: string): void;
}
type Headers = {
  'location': string
}|{'content-location': string}|{};

type FakeResponseFunc =
    (statusCode: number, statusMessage: string, headers?: Headers) => Control;

function makeFakeResponse(callback: (inc: IncomingMessage) => void):
    FakeResponseFunc {
  return (statusCode: number, statusMessage: string, headers: Headers = {}) => {
    type CBs = {
      'data': (b: Buffer) => void,
      'end': () => void,
      'error': (error: Error) => void
    };

    const cbs: CBs = {} as CBs;
    const message = {
      statusCode,
      statusMessage,
      headers,
      on(event: string, cb: (...args: {}[]) => void): void {
        if (event == 'data') cbs['data'] = cb;
        if (event == 'end') cbs['end'] = cb;
        if (event == 'error') cbs['error'] = cb;
      }
    } as IncomingMessage;
    callback(message);

    const control = {
      data(s: string) {
        const buffer = Buffer.from(s, 'utf-8');
        flush().then(() => cbs['data'](buffer));
      },
      end() {
        flush().then(() => cbs['end']());
      },
      error(e: string) {
        const error = new Error(e);
        flush().then(() => cbs['error'](error));
      }
    };
    return control;
  };
}