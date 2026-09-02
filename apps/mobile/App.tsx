import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// M0 placeholder screen. Mobile screens are out of scope for the MVP (PLAN 1.2).
export default function App() {
  return (
    <View style={styles.container}>
      <Text>buddha 모바일 앱 (준비 중)</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
