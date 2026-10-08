    private static readonly UTF8Encoding s_workspaceSnapshotWireUtf8 = new(false, true);

    private static void ValidateWorkspaceText(string value, int maximum, string kind)
    {
        if (value.Length > maximum
            || (kind == "id" && !AuthoringWorkspaceSnapshotContract.IsId(value))
            || (kind == "digest" && !AuthoringWorkspaceSnapshotContract.IsDigest(value)))
        {
            throw new FormatException("workspace_snapshot_text");
        }
    }

    private ref struct WorkspaceSnapshotWireReader
    {
        private readonly ReadOnlySpan<byte> _bytes;
        private int _offset;

        public WorkspaceSnapshotWireReader(ReadOnlySpan<byte> bytes)
        {
            _bytes = bytes;
            _offset = 0;
        }

        public bool Consumed => _offset == _bytes.Length;
        public int Remaining => _bytes.Length - _offset;

        private ReadOnlySpan<byte> Take(int count)
        {
            if (count < 0 || count > Remaining) throw new FormatException("workspace_snapshot_truncated");
            ReadOnlySpan<byte> value = _bytes.Slice(_offset, count);
            _offset += count;
            return value;
        }

        public byte Byte() => Take(1)[0];

        public bool Boolean()
        {
            byte value = Byte();
            if (value > 1) throw new FormatException("workspace_snapshot_boolean");
            return value == 1;
        }

        public int Int32(int minimum, int maximum)
        {
            int value = BinaryPrimitives.ReadInt32LittleEndian(Take(4));
            if (value < minimum || value > maximum) throw new FormatException("workspace_snapshot_integer");
            return value;
        }

        public long Int64(long minimum, long maximum)
        {
            long value = BinaryPrimitives.ReadInt64LittleEndian(Take(8));
            if (value < minimum || value > maximum) throw new FormatException("workspace_snapshot_integer");
            return value;
        }

        public string Closed(string[] values)
        {
            byte tag = Byte();
            if (tag >= values.Length) throw new FormatException("workspace_snapshot_enum");
            return values[tag];
        }

        public string Text(int maximum, string kind)
        {
            int count = Int32(0, maximum * 4);
            string value = s_workspaceSnapshotWireUtf8.GetString(Take(count));
            ValidateWorkspaceText(value, maximum, kind);
            return value;
        }
    }

    private sealed class WorkspaceSnapshotWireWriter
    {
        private readonly ArrayBufferWriter<byte> _buffer = new();

        private Span<byte> Reserve(int count)
        {
            if (count < 0 || count > 65536 - _buffer.WrittenCount) throw new ArgumentException("workspace_snapshot_budget");
            return _buffer.GetSpan(count)[..count];
        }

        public byte[] ToArray() => _buffer.WrittenSpan.ToArray();

        public void Byte(byte value)
        {
            Reserve(1)[0] = value;
            _buffer.Advance(1);
        }

        public void Boolean(bool value) => Byte(value ? (byte)1 : (byte)0);

        public void Int32(int value, int minimum, int maximum)
        {
            if (value < minimum || value > maximum) throw new ArgumentException("workspace_snapshot_integer");
            BinaryPrimitives.WriteInt32LittleEndian(Reserve(4), value);
            _buffer.Advance(4);
        }

        public void Int64(long value, long minimum, long maximum)
        {
            if (value < minimum || value > maximum) throw new ArgumentException("workspace_snapshot_integer");
            BinaryPrimitives.WriteInt64LittleEndian(Reserve(8), value);
            _buffer.Advance(8);
        }

        public void Closed(string value, string[] values)
        {
            int tag = Array.IndexOf(values, value);
            if (tag < 0) throw new ArgumentException("workspace_snapshot_enum");
            Byte((byte)tag);
        }

        public void Text(string value, int maximum, string kind)
        {
            ArgumentNullException.ThrowIfNull(value);
            ValidateWorkspaceText(value, maximum, kind);
            int count = s_workspaceSnapshotWireUtf8.GetByteCount(value);
            Int32(count, 0, maximum * 4);
            if (count == 0) return;
            s_workspaceSnapshotWireUtf8.GetBytes(value, Reserve(count));
            _buffer.Advance(count);
        }
    }
