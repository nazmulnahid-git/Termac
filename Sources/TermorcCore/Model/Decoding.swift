import Foundation

// state.json is written by older builds too, so every field decodes leniently: a missing
// key or a value of the wrong type falls back to the default instead of failing the file.
extension KeyedDecodingContainer {
    func v<T: Decodable>(_ key: Key, _ fallback: @autoclosure () -> T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback()
    }

    func opt<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

// Numbers JavaScript wrote may be ints or floats; timestamps are milliseconds.
public typealias Millis = Int64

public func nowMillis() -> Millis { Millis(Date().timeIntervalSince1970 * 1000) }
