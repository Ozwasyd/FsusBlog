import { PodReader, PodWriter } from './binary.ts';

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
};

export type PodValue<Layout> = {
  [Key in keyof Layout]: Layout[Key] extends { read(reader: PodReader): infer Value } ? Value : never;
};

export function definePodRecord<T extends object>(fields: { [Key in keyof T]: Field<T[Key]> }) {
  const order = Object.keys(fields) as (keyof T)[];
  return [
    (value: T): Uint8Array => {
      const writer = new PodWriter();
      for (const key of order) fields[key].write(writer, value[key]);
      return writer.finish();
    },
    (payload: Uint8Array): T => {
      const reader = new PodReader(payload);
      const value = {} as T;
      for (const key of order) value[key] = fields[key].read(reader);
      reader.finish();
      return value;
    },
  ] as const;
}
