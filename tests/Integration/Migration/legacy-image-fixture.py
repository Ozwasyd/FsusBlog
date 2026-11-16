# Synthetic PNG/JPEG bytes, independent of the production normalizer.
import base64, pathlib, struct, sys, zlib

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))

header = struct.pack('>IIBBBBB', 2, 2, 8, 6, 0, 0, 0)
rows = (b'\x00' + bytes([84, 19, 160, 255]) * 2) * 2
pathlib.Path(sys.argv[1]).write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
# Fixed 2x2 RGB JPEG encoded independently of the production preparer.
pathlib.Path(sys.argv[2]).write_bytes(base64.b64decode(
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKAC'
    'AAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZ'
    'jwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIB'
    'AwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNE'
    'RUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI'
    'ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIB'
    'AgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpD'
    'REVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG'
    'x8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBgQEBAQGBwYGBgYGBwkHBwcHBwcJ'
    'CQkJCQkJCQsLCwsLCw0NDQ0NDg4ODg4ODg4ODv/bAEMBAgICBAMEBgMDBg8KCAoPDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8P'
    'Dw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PD//dAAQAAf/aAAwDAQACEQMRAD8A9y+HGh6LefDzwveXmn2s88+i2UksskSM7u1u'
    'hZmYgkkk5JPJNdp/wjXh3/oFWX/fiP8A+JrA+F//ACTTwl/2ArD/ANJo67mvyM7D/9k='
, validate=True))
