import http.server
import socketserver
import webbrowser
import sys
import os

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

def is_port_in_use(port):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('localhost', port)) == 0

def main():
    global PORT
    print("==================================================")
    print("      I-HEAR Prototype Simulator Launcher       ")
    print("==================================================")
    
    # Resolve port conflicts
    while is_port_in_use(PORT):
        print(f"[Warning] Port {PORT} is already in use.")
        PORT += 1
        
    url = f"http://localhost:{PORT}/sim/index.html"
    
    # Define server config
    handler = MyHTTPRequestHandler
    try:
        with socketserver.TCPServer(("", PORT), handler) as httpd:
            print(f"[Success] Local web server started.")
            print(f"[Action] Please open the following URL in your web browser:")
            print(f"         \033[1;36m{url}\033[0m")
            print("==================================================")
            print("Press Ctrl+C in this terminal to stop the server.")
            
            # Automatically try to open the browser
            try:
                webbrowser.open(url)
            except Exception:
                pass # Fail silently if no desktop environment is present
                
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[System] Web server stopped. Goodbye!")
    except Exception as e:
        print(f"[Fatal] Error starting web server: {e}")

if __name__ == "__main__":
    main()
