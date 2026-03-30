<?php
/**
 * CogmemAi Remote MCP Proxy
 *
 * Forwards MCP requests from https://hifriendbot.com/mcp/ to the local
 * Node.js MCP server running on localhost:3100.
 *
 * Place at: ~/hifriendbot.com/mcp/index.php
 */

// Target: local MCP server
$TARGET = 'http://127.0.0.1:3100';

// Allowed paths — whitelist to prevent SSRF
$ALLOWED_PATHS = ['/mcp', '/health'];

// Allowed HTTP methods
$ALLOWED_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS'];

$method = $_SERVER['REQUEST_METHOD'];

// Reject disallowed methods
if (!in_array($method, $ALLOWED_METHODS, true)) {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode([
        'jsonrpc' => '2.0',
        'error' => ['code' => -32000, 'message' => 'Method not allowed'],
        'id' => null,
    ]);
    exit;
}

// Handle CORS preflight
if ($method === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version');
    header('Access-Control-Expose-Headers: Mcp-Session-Id, Mcp-Protocol-Version');
    http_response_code(204);
    exit;
}

// Build target URL — only allow whitelisted paths
$path = isset($_SERVER['PATH_INFO']) ? $_SERVER['PATH_INFO'] : '';
if (empty($path)) {
    $path = '/mcp';
}
if (!in_array($path, $ALLOWED_PATHS, true)) {
    $path = '/mcp'; // Default to /mcp for any non-whitelisted path
}
$target_url = $TARGET . $path;

// Helper: strip CRLF from header values to prevent header injection
function safe_header_value(string $value): string {
    return str_replace(["\r", "\n"], '', $value);
}

// Collect headers to forward
$forward_headers = [];
$forward_headers[] = 'Content-Type: ' . safe_header_value($_SERVER['CONTENT_TYPE'] ?? 'application/json');

if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $forward_headers[] = 'Authorization: ' . safe_header_value($_SERVER['HTTP_AUTHORIZATION']);
}
if (isset($_SERVER['HTTP_ACCEPT'])) {
    $forward_headers[] = 'Accept: ' . safe_header_value($_SERVER['HTTP_ACCEPT']);
}
if (isset($_SERVER['HTTP_MCP_SESSION_ID'])) {
    $forward_headers[] = 'Mcp-Session-Id: ' . safe_header_value($_SERVER['HTTP_MCP_SESSION_ID']);
}
if (isset($_SERVER['HTTP_MCP_PROTOCOL_VERSION'])) {
    $forward_headers[] = 'Mcp-Protocol-Version: ' . safe_header_value($_SERVER['HTTP_MCP_PROTOCOL_VERSION']);
}

// Read request body
$body = file_get_contents('php://input');

// Forward request via cURL
$ch = curl_init($target_url);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
curl_setopt($ch, CURLOPT_HTTPHEADER, $forward_headers);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
curl_setopt($ch, CURLOPT_TIMEOUT, 300);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);

if ($body) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

// Stream the response back (important for SSE)
$response_headers_sent = false;
$response_code = 200;

// Whitelisted response header prefixes
$allowed_response_headers = ['content-type:', 'mcp-session-id:', 'mcp-protocol-version:', 'cache-control:'];

curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $header) use (&$response_headers_sent, &$response_code, $allowed_response_headers) {
    $len = strlen($header);
    $trimmed = trim($header);

    if (empty($trimmed)) {
        return $len;
    }

    // Parse status line
    if (preg_match('/^HTTP\/[\d.]+ (\d+)/', $trimmed, $matches)) {
        $response_code = (int) $matches[1];
        return $len;
    }

    // Forward only whitelisted headers, reconstructed safely
    $lower = strtolower($trimmed);
    foreach ($allowed_response_headers as $prefix) {
        if (strpos($lower, $prefix) === 0) {
            // Parse name:value and reconstruct to prevent injection
            $colon_pos = strpos($trimmed, ':');
            if ($colon_pos !== false) {
                $name = substr($trimmed, 0, $colon_pos);
                $value = trim(substr($trimmed, $colon_pos + 1));
                $safe_value = str_replace(["\r", "\n"], '', $value);

                if (!$response_headers_sent) {
                    http_response_code($response_code);
                    header('Access-Control-Allow-Origin: *');
                    header('Access-Control-Expose-Headers: Mcp-Session-Id, Mcp-Protocol-Version');
                    $response_headers_sent = true;
                }
                header($name . ': ' . $safe_value);
            }
            break;
        }
    }

    return $len;
});

curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use (&$response_headers_sent, &$response_code) {
    if (!$response_headers_sent) {
        http_response_code($response_code);
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Expose-Headers: Mcp-Session-Id, Mcp-Protocol-Version');
        header('Content-Type: text/event-stream');
        $response_headers_sent = true;
    }
    echo $data;
    if (ob_get_level()) {
        ob_flush();
    }
    flush();
    return strlen($data);
});

// Disable output buffering for SSE streaming
if (ob_get_level()) {
    ob_end_clean();
}

$result = curl_exec($ch);

if ($result === false) {
    curl_close($ch);

    if (!$response_headers_sent) {
        http_response_code(502);
        header('Content-Type: application/json');
        echo json_encode([
            'jsonrpc' => '2.0',
            'error' => [
                'code' => -32603,
                'message' => 'MCP server unavailable',
            ],
            'id' => null,
        ]);
    }
    exit;
}

curl_close($ch);
