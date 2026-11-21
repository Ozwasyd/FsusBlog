import { PodReader, PodWriter, ProtocolError } from './binary.ts';

type Field<T> = {
  read(reader: PodReader): T;
  write(writer: PodWriter, value: T): void;
};

export const podField = {
  i32: {
    read: (reader: PodReader) => reader.i32(),
    write: (writer: PodWriter, value: number) => writer.i32(value),
  },
  i64: {
    read: (reader: PodReader) => reader.i64(),
    write: (writer: PodWriter, value: bigint) => writer.i64(value),
  },
  bool: {
    read: (reader: PodReader) => reader.bool(),
    write: (writer: PodWriter, value: boolean) => writer.bool(value),
  },
  uuid: {
    read: (reader: PodReader) => reader.uuid(),
    write: (writer: PodWriter, value: string) => writer.uuid(value),
  },
  text(limit: number): Field<string> {
    return {
      read: reader => reader.text(limit),
      write: (writer, value) => writer.text(value, limit),
    };
  },
  i32s(limit: number): Field<readonly number[]> {
    return {
      read: reader => reader.i32s(limit),
      write: (writer, value) => writer.i32s(value, limit),
    };
  },
  enumU8<T extends number>(values: Readonly<Record<string, T>>): Field<T> {
    const allowed = new Set<number>(Object.values(values));
    return {
      read: reader => {
        const value = reader.u8();
        if (!allowed.has(value)) throw new ProtocolError('Invalid AEDS enum value');
        return value as T;
      },
      write: (writer, value) => {
        if (!allowed.has(value)) throw new ProtocolError('Invalid AEDS enum value');
        writer.u8(value);
      },
    };
  },
  record<T extends object>(fields: { [Key in keyof T]: Field<T[Key]> }): Field<T> {
    const order = Object.keys(fields) as (keyof T)[];
    return {
      read: reader => {
        const value = {} as T;
        for (const key of order) value[key] = fields[key].read(reader);
        return value;
      },
      write: (writer, value) => {
        for (const key of order) fields[key].write(writer, value[key]);
      },
    };
  },
  list<T>(item: Field<T>, limit: number, minItemBytes = 1): Field<readonly T[]> {
    return {
      read: reader => reader.list(limit, minItemBytes, item.read),
      write: (writer, value) => writer.list(value, limit, item.write),
    };
  },
};

export type PodValue<Layout> = {
  [Key in keyof Layout]: Layout[Key] extends { read(reader: PodReader): infer Value } ? Value : never;
};

export function definePodRecord<T extends object>(fields: { [Key in keyof T]: Field<T[Key]> }) {
  const codec = podField.record(fields);
  return [
    (value: T): Uint8Array => {
      const writer = new PodWriter();
      codec.write(writer, value);
      return writer.finish();
    },
    (payload: Uint8Array): T => {
      const reader = new PodReader(payload);
      const value = codec.read(reader);
      reader.finish();
      return value;
    },
  ] as const;
}
