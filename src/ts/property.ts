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

import {createArrayTypeNode, createKeywordTypeNode, createPropertySignature, createStringLiteral, createToken, createTypeOperatorNode, createTypeReferenceNode, createUnionTypeNode, PropertySignature, SyntaxKind} from 'typescript';

import {Log} from '../logging';
import {Format, ObjectPredicate, TObject, TSubject} from '../triples/triple';
import {UrlNode} from '../triples/types';
import {GetComment, IsDomainIncludes, IsRangeIncludes, IsSupersededBy, IsTypeName} from '../triples/wellKnown';

import {ClassMap} from './class';
import {Context} from './context';
import {withComments} from './util/comments';
import {toClassName} from './util/names';

/**
 * A "class" of properties, not associated with any particuar object.
 */
export class PropertyType {
  private readonly types: UrlNode[] = [];
  private _comment?: string;
  private readonly _supersededBy: TObject[] = [];

  constructor(private readonly subject: TSubject) {}

  get comment() {
    if (!this.deprecated) return this._comment;
    const deprecated = `@deprecated Consider using ${
        this._supersededBy.map(o => o.toString()).join(' or ')} instead.`;

    return this._comment ? `${this._comment}\n${deprecated}` : deprecated;
  }

  get deprecated() {
    return this._supersededBy.length > 0;
  }

  add(value: ObjectPredicate, classes: ClassMap): boolean {
    const c = GetComment(value);
    if (c) {
      if (this._comment) {
        Log(`Duplicate comments provided on property ${
            this.subject.toString()}. It will be overwritten.`);
      }
      this._comment = c.comment;
      return true;
    }

    if (IsRangeIncludes(value.Predicate)) {
      if (!IsTypeName(value.Object))
        throw new Error(`Type expected to be a UrlNode always. When adding ${
            Format(value)} to ${this.subject.toString()}.`);
      this.types.push(value.Object);
      return true;
    }

    if (IsDomainIncludes(value.Predicate)) {
      const cls = classes.get(value.Object.toString());
      if (!cls) {
        throw new Error(
            `Could not find class for ${this.subject.name}, ${Format(value)}.`);
      }
      cls.addProp(new Property(this.subject, this));
      return true;
    }

    if (IsSupersededBy(value.Predicate)) {
      this._supersededBy.push(value.Object);
      return true;
    }

    return false;
  }

  scalarTypeNode() {
    const typeNodes =
        this.types.sort((a, b) => toClassName(a).localeCompare(toClassName(b)))
            .map(type => createTypeReferenceNode(toClassName(type), []));
    switch (typeNodes.length) {
      case 0:
        return createKeywordTypeNode(SyntaxKind.NeverKeyword);
      case 1:
        return typeNodes[0];
      default:
        return createUnionTypeNode(typeNodes);
    }
  }
}

/**
 * A Property on a particular object.
 */
export class Property {
  constructor(readonly key: TSubject, private readonly type: PropertyType) {}

  get deprecated() {
    return this.type.deprecated;
  }

  private typeNode() {
    const node = this.type.scalarTypeNode();
    return createUnionTypeNode([
      node,
      createTypeOperatorNode(
          SyntaxKind.ReadonlyKeyword, createArrayTypeNode(node))
    ]);
  }

  toNode(context: Context): PropertySignature {
    return withComments(
        this.type.comment,
        createPropertySignature(
            /* modifiers= */[],
            createStringLiteral(context.getScopedName(this.key)),
            createToken(SyntaxKind.QuestionToken),
            /*typeNode=*/ this.typeNode(),
            /*initializer=*/ undefined,
            ));
  }
}

export class TypeProperty {
  constructor(private readonly className: TSubject) {}

  toNode(context: Context) {
    return createPropertySignature(
        /* modifiers= */[],
        createStringLiteral('@type'),
        /* questionToken= */ undefined,
        /* typeNode= */
        createTypeReferenceNode(
            `"${context.getScopedName(this.className)}"`,
            /*typeArguments=*/ undefined),
        /* initializer= */ undefined,
    );
  }

  readonly deprecated = false;
}

export function IdPropertyNode() {
  return withComments(
      'IRI identifying the canonical address of this object.',
      createPropertySignature(
          /* modifiers= */[],
          createStringLiteral('@id'),
          createToken(SyntaxKind.QuestionToken),
          /* typeNode= */
          createTypeReferenceNode(
              'string',
              /*typeArguments=*/ undefined),
          /* initializer= */ undefined,
          ));
}
