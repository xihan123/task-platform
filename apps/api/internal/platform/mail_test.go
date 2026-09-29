package platform

import (
	"bufio"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSMTPDelivery(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer listener.Close()
	delivered := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		writer := bufio.NewWriter(conn)
		reply := func(text string) { _, _ = writer.WriteString(text + "\r\n"); _ = writer.Flush() }
		reply("220 localhost ESMTP")
		var body strings.Builder
		inData := false
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			command := strings.TrimRight(line, "\r\n")
			if inData {
				if command == "." {
					reply("250 accepted")
					delivered <- body.String()
					inData = false
				} else {
					body.WriteString(line)
				}
				continue
			}
			switch {
			case strings.HasPrefix(command, "EHLO"), strings.HasPrefix(command, "HELO"):
				reply("250-localhost\r\n250 8BITMIME")
			case strings.HasPrefix(command, "MAIL FROM:"), strings.HasPrefix(command, "RCPT TO:"), command == "NOOP", command == "RSET":
				reply("250 OK")
			case command == "DATA":
				reply("354 go ahead")
				inData = true
			case command == "QUIT":
				reply("221 bye")
				return
			default:
				reply("500 unsupported")
			}
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	app := &App{Config: Config{EmailEnabled: true, SMTPHost: "127.0.0.1", SMTPPort: port, SMTPRequireTLS: false, MailFrom: "sender@example.test", AppURL: "http://localhost:3000"}}
	require.NoError(t, app.sendMail("recipient@example.test", "Test message", "private delivery", "8067e12a-b323-4d11-a973-6daf80f423ba"))
	select {
	case message := <-delivered:
		require.Contains(t, message, "private delivery")
		require.Contains(t, message, "Message-ID:")
		require.NotContains(t, message, "<<")
	case <-time.After(3 * time.Second):
		t.Fatal("SMTP delivery not observed on " + strconv.Itoa(port))
	}
}
